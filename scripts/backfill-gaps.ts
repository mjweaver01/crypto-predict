/**
 * Gap-fill the prediction ledger: reconstruct and insert entries ONLY for
 * windows that have no record at all (live or backfill). Every existing entry
 * is left exactly as-is — this script is safe to run alongside a live server.
 *
 * Logic mirrors backfill.ts (raw model prob ~1 min into the window, real
 * Polymarket outcome, source = "backfill") but adds a hard skip-if-present
 * guard so genuine live committed calls are never overwritten.
 *
 * Usage:
 *   bun run scripts/backfill-gaps.ts [-- --lookback5 144 --lookback15 96 --lookback1h 48]
 *
 * Defaults cover the last 12h of 5m windows (144×5m), 24h of 15m (96×15m),
 * and 48h of 1h (48×1h) — enough to recover from an overnight downtime.
 */

import { fetchKlineRange, type Candle } from '../src/server/sources/binance.ts';
import {
  fetchMarketOutcome,
  slugFor,
} from '../src/server/sources/polymarket.ts';
import { buildModel, predictAbove } from '../src/server/model/forecast.ts';
import { getLedger } from '../src/server/model/ledger.ts';
import { env } from '../src/server/cache.ts';
import type { LedgerEntry, RangeId, Side } from '../src/shared/types.ts';

const MIN = 60_000;
const WARMUP_MIN = 240;
const PATH = env('LEDGER_PATH', `${process.cwd()}/data/ledger.json`);

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

interface Fam {
  id: Exclude<RangeId, '1d'>;
  windowMin: number;
  lookback: number;
}

const FAMS: Fam[] = [
  { id: '5m', windowMin: 5, lookback: arg('lookback5', 144) },
  { id: '15m', windowMin: 15, lookback: arg('lookback15', 96) },
  { id: '1h', windowMin: 60, lookback: arg('lookback1h', 48) },
];

async function mapPool<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** Most recent `count` CLOSED window starts (newest first). */
function recentWindowStarts(windowMin: number, count: number): number[] {
  const windowMs = windowMin * MIN;
  const lastClosed =
    Math.floor(Date.now() / windowMs) * windowMs - 2 * windowMs;
  return Array.from({ length: count }, (_, i) => lastClosed - i * windowMs);
}

async function main() {
  // ── Load existing ledger to build the skip-set ─────────────────────────────
  console.log('loading ledger…');
  const existing = await getLedger();
  const presentIds = new Set(existing.map(e => e.id));
  console.log(`  ${existing.length} entries already in ledger\n`);

  // ── Find which windows we actually need to fill ────────────────────────────
  type GapWindow = { fam: Fam; startMs: number };
  const gaps: GapWindow[] = [];
  for (const fam of FAMS) {
    const starts = recentWindowStarts(fam.windowMin, fam.lookback);
    const missing = starts.filter(s => !presentIds.has(`${fam.id}:${s}`));
    console.log(
      `${fam.id}: ${fam.lookback} windows checked · ` +
        `${starts.length - missing.length} present · ${missing.length} missing`
    );
    for (const s of missing) gaps.push({ fam, startMs: s });
  }

  if (gaps.length === 0) {
    console.log(
      '\nnothing to fill — ledger is complete for the checked range.'
    );
    return;
  }

  // ── Fetch klines once, covering the full range needed ─────────────────────
  const oldest1h = recentWindowStarts(
    60,
    FAMS.find(f => f.id === '1h')!.lookback
  ).at(-1)!;
  const klStart = oldest1h - (WARMUP_MIN + 5) * MIN;
  const HOUR = 60 * MIN;
  const hourStart = oldest1h - 720 * HOUR;

  console.log('\nfetching klines…');
  const [candles, hourCandlesAll] = await Promise.all([
    fetchKlineRange('1m', klStart, Date.now()),
    fetchKlineRange('1h', hourStart, Date.now()),
  ]);

  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  const idxOf = new Map<number, number>();
  opens.forEach((t, i) => idxOf.set(t, i));
  const hourSorted = [...hourCandlesAll].sort(
    (a, b) => a.openTime - b.openTime
  );
  console.log(
    `fetched ${candles.length} 1m + ${hourSorted.length} 1h candles\n`
  );

  /** Completed hourly candles strictly before an instant (no look-ahead). */
  function hoursBefore(instantMs: number): Candle[] {
    return hourSorted.filter(c => c.openTime < instantMs);
  }

  /**
   * Raw model probUp ~1 minute into the window, mirroring live commit timing.
   * Returns null when we don't have enough candle history (too far back).
   */
  function modelProbAtCommit(
    startMs: number,
    windowMin: number
  ): { probUp: number; horizon: number } | null {
    const openCandle = byOpen.get(startMs);
    const idx = idxOf.get(startMs);
    if (!openCandle || idx === undefined || idx < WARMUP_MIN) return null;
    const trailing: Candle[] = [];
    for (let j = idx - WARMUP_MIN + 1; j <= idx; j++) {
      trailing.push(byOpen.get(opens[j]!)!);
    }
    const horizon = windowMin - 1;
    const model = buildModel({
      price: openCandle.close,
      change24hPct: 0,
      minuteCandles: trailing,
      hourCandles: hoursBefore(startMs),
    });
    return {
      probUp: predictAbove(model, openCandle.open, horizon, '').probAbove,
      horizon,
    };
  }

  // ── Fill each gap ──────────────────────────────────────────────────────────
  console.log(`filling ${gaps.length} gap(s)…\n`);

  const filled: LedgerEntry[] = [];
  const results = await mapPool(gaps, 6, async ({ fam, startMs }) => {
    const endMs = startMs + fam.windowMin * MIN;
    const slug = slugFor[fam.id](startMs);

    const outcome = await fetchMarketOutcome(slug);
    if (!outcome) return { startMs, fam, status: 'no-outcome' };

    const call = modelProbAtCommit(startMs, fam.windowMin);
    if (!call) return { startMs, fam, status: 'no-candle' };

    const probUp = call.probUp;
    const side: Side = probUp >= 0.5 ? 'UP' : 'DOWN';
    const realized: Side = outcome.outcomeUp ? 'UP' : 'DOWN';

    const entry: LedgerEntry = {
      id: `${fam.id}:${startMs}`,
      rangeId: fam.id,
      slug,
      windowStart: new Date(startMs).toISOString(),
      windowEnd: new Date(endMs).toISOString(),
      strike: byOpen.get(startMs)!.open,
      probUp,
      rawProbUp: probUp,
      side,
      confidence: Math.max(probUp, 1 - probUp),
      horizonMinutes: call.horizon,
      decidedAt: new Date(startMs + MIN).toISOString(),
      source: 'backfill',
      outcome: realized,
      correct: side === realized,
      resolvedBy: 'polymarket',
      resolvedAt: new Date().toISOString(),
    };
    return { startMs, fam, status: 'ok', entry };
  });

  for (const r of results) {
    if (r.status === 'ok' && r.entry) {
      filled.push(r.entry);
    } else {
      const loc = new Date(r.startMs).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
      console.log(`  skipped ${r.fam.id} ${loc} — ${r.status}`);
    }
  }

  if (filled.length === 0) {
    console.log(
      'no entries could be reconstructed (Polymarket may not have settled these yet).'
    );
    return;
  }

  // ── Write only into empty slots — never overwrite ─────────────────────────
  const store = (await Bun.file(PATH).json()) as Record<string, LedgerEntry>;
  let written = 0;
  for (const e of filled) {
    if (store[e.id]) continue; // double-check: live server may have written it
    store[e.id] = e;
    written++;
  }
  await Bun.write(PATH, JSON.stringify(store, null, 2));

  const correct = filled.filter(e => e.correct).length;
  console.log(
    `\nwrote ${written} gap entries  ` +
      `(${filled.length - written} already present by the time we wrote).\n` +
      `accuracy on filled gaps: ${filled.length ? ((correct / filled.length) * 100).toFixed(1) : '—'}%`
  );

  // ── Summary by family ──────────────────────────────────────────────────────
  for (const fam of FAMS) {
    const sub = filled.filter(e => e.rangeId === fam.id);
    if (!sub.length) continue;
    const ok = sub.filter(e => e.correct).length;
    console.log(
      `  ${fam.id}: ${sub.length} filled · ` +
        `${((ok / sub.length) * 100).toFixed(1)}% accuracy`
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
