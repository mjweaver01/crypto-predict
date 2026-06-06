/**
 * Walk-forward backtest for the BTC Up/Down direction model.
 *
 * For each historical 5m and 15m window we sample several decision points
 * *inside* the window (when price has moved off the open and the model has real
 * information), rebuild the model from ONLY the candles available at that
 * instant, and predict P(close_at_window_end >= window_open). We then score
 * against the realized outcome.
 *
 * Three forecasters are compared on identical samples:
 *   - model:    the current model (EWMA + Garman-Klass vol, shrunk drift)
 *   - naive:    the original model (equal-weight close-to-close, full drift)
 *   - baseline: always 0.5
 *
 * Config is read from the same MODEL_* env vars the live model uses, so you can
 * sweep them:  MODEL_DRIFT_SHRINK=0 bun run backtest -- --days 5
 *
 * Usage:  bun run backtest [-- --days N --warmup M]
 */
import { fetchKlineRange, type Candle } from '../src/server/sources/binance.ts';
import {
  buildModel,
  predictAbove,
  normCdf,
} from '../src/server/model/forecast.ts';
import { score, reliability } from '../src/server/model/scoring.ts';

const SYMBOL = process.env.BTC_SYMBOL ?? 'BTCUSDT';
const MIN = 60_000;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

const DAYS = arg('days', Number(process.env.BACKTEST_DAYS ?? 3));
const WARMUP_MIN = arg('warmup', 240); // trailing minute-candles per decision

// ── Naive (original) forecaster, for an apples-to-apples comparison ────────
function naiveStats(candles: Candle[]): { mean: number; std: number } {
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    const cur = candles[i]!.close;
    if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
  }
  const n = rets.length;
  if (n < 2) return { mean: 0, std: 0 };
  const mean = rets.reduce((a, b) => a + b, 0) / n;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1);
  return { mean, std: Math.sqrt(variance) };
}

function naivePredict(
  trailing: Candle[],
  price: number,
  strike: number,
  horizon: number
): number {
  const { mean, std } = naiveStats(trailing);
  const sigmaSum = std * Math.sqrt(horizon);
  const driftSum = mean * horizon;
  if (sigmaSum <= 0) return price > strike ? 1 : 0;
  return 1 - normCdf((Math.log(strike / price) - driftSum) / sigmaSum);
}

interface Series {
  model: number[];
  naive: number[];
  base: number[];
  outcome: number[];
}
const empty = (): Series => ({ model: [], naive: [], base: [], outcome: [] });

function runWindow(
  byOpen: Map<number, Candle>,
  sortedOpens: number[],
  windowMin: number,
  offsets: number[],
  acc: Series
) {
  const windowMs = windowMin * MIN;
  const firstOpen = sortedOpens[0]!;
  const lastOpen = sortedOpens[sortedOpens.length - 1]!;
  // Align to the first window boundary at/after we have WARMUP_MIN of history.
  let s = Math.ceil((firstOpen + WARMUP_MIN * MIN) / windowMs) * windowMs;
  for (; s + windowMs - MIN <= lastOpen; s += windowMs) {
    const openCandle = byOpen.get(s);
    const endCandle = byOpen.get(s + windowMs - MIN);
    if (!openCandle || !endCandle) continue;
    const strike = openCandle.open;
    const outcome = endCandle.close >= strike ? 1 : 0;

    for (const offset of offsets) {
      if (offset < 1 || offset >= windowMin) continue;
      const decisionOpen = s + (offset - 1) * MIN;
      const decisionCandle = byOpen.get(decisionOpen);
      if (!decisionCandle) continue;
      const price = decisionCandle.close;
      const remaining = windowMin - offset;

      // Trailing minute candles strictly before the decision instant.
      const endIdx = sortedOpens.indexOf(decisionOpen);
      if (endIdx < WARMUP_MIN) continue;
      const trailing: Candle[] = [];
      for (let j = endIdx - WARMUP_MIN + 1; j <= endIdx; j++) {
        trailing.push(byOpen.get(sortedOpens[j]!)!);
      }

      const model = buildModel({
        price,
        change24hPct: 0,
        minuteCandles: trailing,
        hourCandles: [],
      });
      const pModel = predictAbove(model, strike, remaining, '').probAbove;
      const pNaive = naivePredict(trailing, price, strike, remaining);

      acc.model.push(pModel);
      acc.naive.push(pNaive);
      acc.base.push(0.5);
      acc.outcome.push(outcome);
    }
  }
}

function pct(x: number): string {
  return Number.isFinite(x) ? (x * 100).toFixed(1) + '%' : '—';
}
function f4(x: number): string {
  return Number.isFinite(x) ? x.toFixed(4) : '—';
}

function report(label: string, probs: number[], outcomes: number[]) {
  const s = score(probs, outcomes);
  console.log(
    `  ${label.padEnd(9)} brier ${f4(s.brier)}  logloss ${f4(s.logLoss)}  acc ${pct(
      s.accuracy
    )}`
  );
}

async function main() {
  const now = Date.now();
  const start = now - (DAYS * 1440 + WARMUP_MIN + 5) * MIN;
  console.log(
    `Backtest ${SYMBOL} · ${DAYS}d · warmup ${WARMUP_MIN}m\n` +
      `config: EWMA_LAMBDA=${process.env.MODEL_EWMA_LAMBDA ?? '0.94'} ` +
      `DRIFT_SHRINK=${process.env.MODEL_DRIFT_SHRINK ?? '0'} ` +
      `DRIFT_CAP_SIGMAS=${process.env.MODEL_DRIFT_CAP_SIGMAS ?? '0.5'}\n`
  );

  const candles = await fetchKlineRange('1m', start, now);
  if (candles.length < WARMUP_MIN + 100) {
    throw new Error(`not enough candles (${candles.length})`);
  }
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const sortedOpens = [...byOpen.keys()].sort((a, b) => a - b);
  console.log(`fetched ${candles.length} 1m candles\n`);

  const configs: { name: string; windowMin: number; offsets: number[] }[] = [
    { name: '5m window', windowMin: 5, offsets: [1, 2, 3, 4] },
    { name: '15m window', windowMin: 15, offsets: [3, 6, 9, 12, 14] },
  ];

  for (const cfg of configs) {
    const acc = empty();
    runWindow(byOpen, sortedOpens, cfg.windowMin, cfg.offsets, acc);
    const base = score(acc.base, acc.outcome);
    console.log(
      `${cfg.name}  ·  ${acc.outcome.length} samples  ·  base rate up ${pct(
        base.baseRate
      )}`
    );
    report('model', acc.model, acc.outcome);
    report('naive', acc.naive, acc.outcome);
    report('0.5', acc.base, acc.outcome);

    const rel = reliability(acc.model, acc.outcome, 5);
    const cells = rel
      .filter(b => b.n > 0)
      .map(
        b =>
          `[${b.lo.toFixed(1)}-${b.hi.toFixed(1)}] pred ${pct(b.meanPred)}→obs ${pct(b.observed)} (n=${b.n})`
      )
      .join('\n    ');
    console.log(`  calibration (model):\n    ${cells}\n`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
