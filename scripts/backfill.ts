/**
 * Backfill the prediction ledger with historical COMMITTED calls vs outcomes,
 * so the learned calibrator (src/server/model/calibration.ts) has data to fit on
 * immediately instead of waiting days for live outcomes to accumulate.
 *
 * For recent RESOLVED 5m / 15m / 1h windows we reconstruct the model's RAW
 * probability EARLY in the window (one minute after the open — mirroring where
 * we commit a call live, while the horizon is still long), pair it with the REAL
 * Polymarket resolution, and write it to data/ledger.json with `rawProbUp` set
 * so refreshCalibrators() picks it up. This matches the distribution the
 * calibrator is applied to: forward-looking calls, not pre-close snapshots.
 *
 * Note: the live committed call also includes a small LLM bias nudge, which we
 * cannot replay here — backfilled rows reflect the pure statistical model. The
 * nudge is small (±0.08 max) so the calibration signal is dominated by the model.
 *
 * Usage:  bun run backfill [-- --count5 144 --count15 96 --count1h 48]
 */
import { fetchKlineRange, type Candle } from '../src/server/sources/binance.ts';
import {
  fetchMarketOutcome,
  slugFor,
} from '../src/server/sources/polymarket.ts';
import { buildModel, predictAbove } from '../src/server/model/forecast.ts';
import { addEntries } from '../src/server/model/ledger.ts';
import type { LedgerEntry, RangeId, Side } from '../src/shared/types.ts';

const MIN = 60_000;
const WARMUP_MIN = 240;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

interface Fam {
  id: Exclude<RangeId, '1d'>;
  windowMin: number;
  count: number;
}
const FAMS: Fam[] = [
  { id: '5m', windowMin: 5, count: arg('count5', 144) },
  { id: '15m', windowMin: 15, count: arg('count15', 96) },
  { id: '1h', windowMin: 60, count: arg('count1h', 48) },
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

function recentWindowStarts(windowMin: number, count: number): number[] {
  const windowMs = windowMin * MIN;
  const lastClosed =
    Math.floor(Date.now() / windowMs) * windowMs - 2 * windowMs;
  return Array.from({ length: count }, (_, i) => lastClosed - i * windowMs);
}

async function main() {
  // Oldest 1m candle we need: oldest 1h window start - warmup.
  const oldest1h = recentWindowStarts(
    60,
    FAMS.find(f => f.id === '1h')!.count
  ).at(-1)!;
  const klStart = oldest1h - (WARMUP_MIN + 5) * MIN;
  console.log('fetching klines…');
  // Fetch 1h candles far enough back that the long-horizon EWMA has warmed up
  // by the oldest window (the live model uses 720 hourly candles).
  const HOUR = 60 * MIN;
  const [candles, hourCandlesAll] = await Promise.all([
    fetchKlineRange('1m', klStart, Date.now()),
    fetchKlineRange('1h', oldest1h - 720 * HOUR, Date.now()),
  ]);
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  const idxOf = new Map<number, number>();
  opens.forEach((t, i) => idxOf.set(t, i));
  const hourSorted = [...hourCandlesAll].sort((a, b) => a.openTime - b.openTime);
  console.log(
    `fetched ${candles.length} 1m + ${hourSorted.length} 1h candles\n`
  );

  /** Completed hourly candles strictly before an instant (no look-ahead). */
  function hoursBefore(instantMs: number): Candle[] {
    return hourSorted.filter(c => c.openTime < instantMs);
  }

  /**
   * Raw model probUp committed ~1 minute into the window, using only candles
   * available by then — mirroring the live committed-call timing (locked in
   * early, while the horizon is still long). The strike is the window open; the
   * decision price is the close of the first 1m candle after the open.
   */
  function modelProbAtCommit(
    startMs: number,
    windowMin: number
  ): { probUp: number; horizon: number } | null {
    const openCandle = byOpen.get(startMs);
    const idx = idxOf.get(startMs); // candle opening at the window start
    if (!openCandle || idx === undefined || idx < WARMUP_MIN) return null;
    const trailing: Candle[] = [];
    for (let j = idx - WARMUP_MIN + 1; j <= idx; j++) {
      trailing.push(byOpen.get(opens[j]!)!);
    }
    const horizon = windowMin - 1; // one minute elapsed at commit
    const model = buildModel({
      price: openCandle.close, // price one minute into the window
      change24hPct: 0,
      minuteCandles: trailing,
      // Long-horizon families (1h) need real hourly stats; supplying only
      // completed hours up to the window start avoids look-ahead. 5m/15m use
      // minute stats so this is harmless for them.
      hourCandles: hoursBefore(startMs),
    });
    return {
      probUp: predictAbove(model, openCandle.open, horizon, '').probAbove,
      horizon,
    };
  }

  const all: LedgerEntry[] = [];
  for (const fam of FAMS) {
    const starts = recentWindowStarts(fam.windowMin, fam.count);
    const rows = await mapPool(starts, 6, async startMs => {
      const endMs = startMs + fam.windowMin * MIN;
      const slug = slugFor[fam.id](startMs);
      const outcome = await fetchMarketOutcome(slug);
      if (!outcome) return null;
      const call = modelProbAtCommit(startMs, fam.windowMin);
      if (call === null) return null;
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
        // No live calibrator existed historically, so raw == committed prob.
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
      return entry;
    });
    const got = rows.filter((r): r is LedgerEntry => r !== null);
    const correct = got.filter(e => e.correct).length;
    console.log(
      `${fam.id}: ${got.length}/${fam.count} resolved · accuracy ${
        got.length ? ((correct / got.length) * 100).toFixed(1) : '—'
      }%`
    );
    all.push(...got);
  }

  await addEntries(all);
  console.log(`\nwrote ${all.length} backfilled entries to the ledger.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
