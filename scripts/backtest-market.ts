/**
 * Ensemble backtest: is blending our model with the live Polymarket price more
 * accurate than either alone?
 *
 * For recent RESOLVED 5m/15m markets we pull the realized outcome (Gamma) and
 * the historical implied-Up series (CLOB prices-history). At several decision
 * points inside each window we compute:
 *   - model:  our forecast from Binance klines available at that instant
 *   - market: the Polymarket implied-Up at that instant
 *   - blend:  w*market + (1-w)*model, swept over w in [0,1]
 * and score each against the realized outcome with Brier + log-loss. The script
 * prints the weight sweep and the best blend so we can pick MODEL_MARKET_WEIGHT.
 *
 * Usage:  bun run backtest:market [-- --limit 120 --warmup 240]
 */
import { fetchKlineRange, type Candle } from '../src/server/sources/binance.ts';
import {
  fetchMarketOutcome,
  fetchPriceHistory,
  slugFor,
  type PricePointRaw,
} from '../src/server/sources/polymarket.ts';
import { buildModel, predictAbove } from '../src/server/model/forecast.ts';
import { score } from '../src/server/model/scoring.ts';

const MIN = 60_000;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

const LIMIT = arg('limit', 120); // resolved markets per family
const WARMUP_MIN = arg('warmup', 240);

interface Family {
  id: '5m' | '15m';
  windowMin: number;
  offsets: number[];
}
const FAMILIES: Family[] = [
  { id: '5m', windowMin: 5, offsets: [1, 2, 3, 4] },
  { id: '15m', windowMin: 15, offsets: [3, 6, 9, 12, 14] },
];

/** Run `fn` over `items` with at most `n` in flight at once. */
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

/** Most recent `count` fully-closed window starts for a window size, descending. */
function recentWindowStarts(windowMin: number, count: number): number[] {
  const windowMs = windowMin * MIN;
  // Skip the latest 2 windows to allow time for on-chain resolution.
  const lastClosed =
    Math.floor(Date.now() / windowMs) * windowMs - 2 * windowMs;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(lastClosed - i * windowMs);
  return out;
}

/** Market implied-Up at `decisionSec`: last sample at/before it (else 0.5). */
function marketAt(history: PricePointRaw[], decisionSec: number): number {
  let p = 0.5;
  for (const pt of history) {
    if (pt.t <= decisionSec) p = pt.p;
    else break;
  }
  return Math.min(1, Math.max(0, p));
}

interface Acc {
  model: number[];
  market: number[];
  outcome: number[];
}

async function main() {
  console.log(
    `Ensemble backtest · ${LIMIT} markets/family · warmup ${WARMUP_MIN}m\n`
  );

  // Klines covering the oldest 15m window we'll touch (+ warmup), through now.
  const oldestStart = recentWindowStarts(15, LIMIT).at(-1)!;
  const klStart = oldestStart - (WARMUP_MIN + 5) * MIN;
  const candles = await fetchKlineRange('1m', klStart, Date.now());
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const idxOf = new Map<number, number>();
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  opens.forEach((t, i) => idxOf.set(t, i));
  console.log(`fetched ${candles.length} 1m candles\n`);

  function modelProb(
    s: number,
    windowMin: number,
    offset: number
  ): number | null {
    const decisionOpen = s + (offset - 1) * MIN;
    const idx = idxOf.get(decisionOpen);
    const openCandle = byOpen.get(s);
    const decisionCandle = byOpen.get(decisionOpen);
    if (
      idx === undefined ||
      idx < WARMUP_MIN ||
      !openCandle ||
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
    return predictAbove(model, openCandle.open, windowMin - offset, '')
      .probAbove;
  }

  const weights = Array.from({ length: 11 }, (_, i) => i / 10);

  for (const fam of FAMILIES) {
    const starts = recentWindowStarts(fam.windowMin, LIMIT);
    const markets = await mapPool(starts, 6, async s => {
      const outcome = await fetchMarketOutcome(slugFor[fam.id](s));
      if (!outcome) return null;
      const history = await fetchPriceHistory(outcome.upTokenId);
      if (history.length === 0) return null;
      return { s, outcome, history };
    });

    const acc: Acc = { model: [], market: [], outcome: [] };
    let resolved = 0;
    for (const m of markets) {
      if (!m) continue;
      resolved++;
      for (const offset of fam.offsets) {
        const pModel = modelProb(m.s, fam.windowMin, offset);
        if (pModel === null) continue;
        const decisionSec = Math.floor((m.s + offset * MIN) / 1000);
        const pMarket = marketAt(m.history, decisionSec);
        acc.model.push(pModel);
        acc.market.push(pMarket);
        acc.outcome.push(m.outcome.outcomeUp);
      }
    }

    const sm = score(acc.model, acc.outcome);
    const sk = score(acc.market, acc.outcome);
    console.log(
      `${fam.id} window · ${resolved} resolved markets · ${acc.outcome.length} samples · base rate up ${(sk.baseRate * 100).toFixed(1)}%`
    );
    console.log(
      `  model   brier ${sm.brier.toFixed(4)}  logloss ${sm.logLoss.toFixed(4)}  acc ${(sm.accuracy * 100).toFixed(1)}%`
    );
    console.log(
      `  market  brier ${sk.brier.toFixed(4)}  logloss ${sk.logLoss.toFixed(4)}  acc ${(sk.accuracy * 100).toFixed(1)}%`
    );

    let best = { w: 0, logLoss: Infinity, brier: Infinity };
    console.log('  blend  w·market + (1-w)·model:');
    for (const w of weights) {
      const blend = acc.model.map((pm, i) => w * acc.market[i]! + (1 - w) * pm);
      const sb = score(blend, acc.outcome);
      const star = sb.logLoss < best.logLoss ? ' *' : '';
      if (sb.logLoss < best.logLoss)
        best = { w, logLoss: sb.logLoss, brier: sb.brier };
      console.log(
        `    w=${w.toFixed(1)}  brier ${sb.brier.toFixed(4)}  logloss ${sb.logLoss.toFixed(4)}${star}`
      );
    }
    console.log(
      `  → best blend w=${best.w.toFixed(1)} (logloss ${best.logLoss.toFixed(4)})\n`
    );
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
