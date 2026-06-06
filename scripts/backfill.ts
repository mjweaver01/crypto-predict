/**
 * Backfill the prediction ledger with historical calls vs outcomes.
 *
 * For recent RESOLVED 5m / 15m / 1h windows we reconstruct the model's pick
 * using only the Binance candles available ~1 minute before the window closed
 * (mirroring our live "most-informed pre-close call"), pair it with the REAL
 * Polymarket resolution, and write it to data/ledger.json.
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
  const candles = await fetchKlineRange('1m', klStart, Date.now());
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  const idxOf = new Map<number, number>();
  opens.forEach((t, i) => idxOf.set(t, i));
  console.log(`fetched ${candles.length} 1m candles\n`);

  /** Model probUp ~1 minute before window close, using only prior candles. */
  function modelProbPreClose(startMs: number, endMs: number): number | null {
    const openCandle = byOpen.get(startMs);
    const decisionOpen = endMs - 2 * MIN; // candle closing 1 min before window end
    const idx = idxOf.get(decisionOpen);
    const decisionCandle = byOpen.get(decisionOpen);
    if (
      !openCandle ||
      idx === undefined ||
      idx < WARMUP_MIN ||
      !decisionCandle
    ) {
      return null;
    }
    const trailing: Candle[] = [];
    for (let j = idx - WARMUP_MIN + 1; j <= idx; j++) {
      trailing.push(byOpen.get(opens[j]!)!);
    }
    const model = buildModel({
      price: decisionCandle.close,
      change24hPct: 0,
      minuteCandles: trailing,
      hourCandles: [],
    });
    return predictAbove(model, openCandle.open, 1, '').probAbove;
  }

  const all: LedgerEntry[] = [];
  for (const fam of FAMS) {
    const starts = recentWindowStarts(fam.windowMin, fam.count);
    const rows = await mapPool(starts, 6, async startMs => {
      const endMs = startMs + fam.windowMin * MIN;
      const slug = slugFor[fam.id](startMs);
      const outcome = await fetchMarketOutcome(slug);
      if (!outcome) return null;
      const probUp = modelProbPreClose(startMs, endMs);
      if (probUp === null) return null;
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
        side,
        confidence: Math.max(probUp, 1 - probUp),
        horizonMinutes: 1,
        decidedAt: new Date(endMs - MIN).toISOString(),
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
