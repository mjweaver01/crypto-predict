import type { Candle } from '../sources/binance.ts';
import type {
  AbovePrediction,
  MarketStats,
  PriceForecast,
} from '../../shared/types.ts';

/**
 * Dependency-free price model.
 *
 * Log-returns are treated as i.i.d. normal with a small drift (mu) and
 * volatility (sigma) estimated from recent candles. Over a horizon of h
 * periods the cumulative log-return is ~ Normal(mu*h, sigma^2*h), so:
 *   - direction:   P(up)   = Phi(mu*h / (sigma*sqrt(h)))
 *   - above strike: P(>K)  = 1 - Phi((ln(K/price) - mu*h) / (sigma*sqrt(h)))
 *   - point price:  price * exp(mu*h), with a lognormal ~95% band.
 *
 * Short horizons (5m/15m) use per-minute stats; longer horizons use per-hour
 * stats converted to per-minute so everything composes in minutes.
 */

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

interface ReturnStats {
  mean: number;
  std: number;
}

/** Mean and std of log-returns between consecutive candle closes. */
function logReturnStats(candles: Candle[]): ReturnStats {
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

export interface ModelInputs {
  price: number;
  change24hPct: number;
  minuteCandles: Candle[];
  hourCandles: Candle[];
}

export interface Model {
  stats: MarketStats;
  /** Per-minute drift/vol used for short horizons. */
  minute: ReturnStats;
  /** Per-minute drift/vol derived from hourly candles, for long horizons. */
  long: ReturnStats;
}

export function buildModel(inputs: ModelInputs): Model {
  const minute = logReturnStats(inputs.minuteCandles);
  const hour = logReturnStats(inputs.hourCandles);

  // Convert hourly stats to a per-minute basis (variance scales linearly).
  const long: ReturnStats = {
    mean: hour.mean / 60,
    std: hour.std / Math.sqrt(60),
  };

  return {
    minute,
    long,
    stats: {
      price: inputs.price,
      driftPerMin: minute.mean,
      volPerMin: minute.std,
      volPerHour: hour.std,
      change24hPct: inputs.change24hPct,
    },
  };
}

/** Choose the stats appropriate for a horizon (minute vs long-run). */
function statsFor(model: Model, horizonMinutes: number): ReturnStats {
  return horizonMinutes <= 30 ? model.minute : model.long;
}

export function predictAbove(
  model: Model,
  strike: number,
  horizonMinutes: number,
  targetTime: string
): AbovePrediction {
  const { mean, std } = statsFor(model, horizonMinutes);
  const driftSum = mean * horizonMinutes;
  const sigmaSum = std * Math.sqrt(horizonMinutes);
  const logRatio = Math.log(strike / model.stats.price);
  const probAbove =
    sigmaSum > 0
      ? 1 - normCdf((logRatio - driftSum) / sigmaSum)
      : model.stats.price > strike
        ? 1
        : 0;
  return { strike, targetTime, horizonMinutes, probAbove };
}

export function predictPrice(
  model: Model,
  horizonMinutes: number,
  targetTime: string,
  startPrice: number
): PriceForecast {
  const { mean, std } = statsFor(model, horizonMinutes);
  const driftSum = mean * horizonMinutes;
  const sigmaSum = std * Math.sqrt(horizonMinutes);
  const price = model.stats.price;
  return {
    targetTime,
    horizonMinutes,
    startPrice,
    point: price * Math.exp(driftSum),
    low: price * Math.exp(driftSum - 1.96 * sigmaSum),
    high: price * Math.exp(driftSum + 1.96 * sigmaSum),
  };
}
