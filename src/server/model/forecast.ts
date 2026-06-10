import { env } from '../cache.ts';
import type { Candle } from '../sources/binance.ts';
import type {
  AbovePrediction,
  MarketStats,
  PriceForecast,
} from '../../shared/types.ts';

/**
 * Dependency-free price model.
 *
 * Log-returns are treated as approximately normal with a small (heavily
 * shrunk) drift mu and volatility sigma estimated from recent candles. Over a
 * horizon of h periods the cumulative log-return is ~ Normal(mu*h, sigma^2*h):
 *   - above strike: P(>K)  = 1 - Phi((ln(K/price) - mu*h) / (sigma*sqrt(h)))
 *   - point price:  price * exp(mu*h), with a lognormal ~95% band.
 *
 * Two accuracy-oriented refinements over a naive sample mean/variance:
 *   1. Volatility uses an EWMA of the Garman-Klass range estimator (O/H/L/C),
 *      which is far more efficient and regime-aware than equal-weighted
 *      close-to-close variance.
 *   2. Drift is shrunk toward zero and capped relative to diffusion, because
 *      trailing drift is mostly noise and, extrapolated linearly, dominates and
 *      biases long-horizon probabilities. See MODEL_DRIFT_* below.
 *
 * Short horizons (<=30m) use per-minute stats; longer horizons use per-hour
 * stats converted to per-minute so everything composes in minutes.
 */

// ── Tunable config (env-overridable so the backtest can sweep it) ──────────
/** EWMA decay for drift/vol; closer to 1 = longer memory (RiskMetrics 0.94). */
const EWMA_LAMBDA = clamp01(Number(env('MODEL_EWMA_LAMBDA', '0.94')) || 0.94);
// Fraction of the estimated drift that survives shrinkage (0 = driftless).
// Default 0: backtesting (scripts/backtest.ts) shows trailing drift, even
// shrunk, raises Brier/log-loss on 5m & 15m direction — a driftless random
// walk is the best directional estimator. Re-enable (e.g. 0.2) to sweep.
const DRIFT_SHRINK = Math.max(0, Number(env('MODEL_DRIFT_SHRINK', '0')) || 0);
/** Cap on |drift| as a multiple of the horizon's sigma (diffusion). */
const DRIFT_CAP_SIGMAS = Math.max(
  0,
  Number(env('MODEL_DRIFT_CAP_SIGMAS', '0.5')) || 0
);

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Standard normal CDF via the Abramowitz-Stegun erf approximation. */
export function normCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p =
    d *
    t *
    (0.31938153 +
      t *
        (-0.356563782 +
          t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface ReturnStats {
  /** Per-period (EWMA) mean log-return. */
  mean: number;
  /** Per-period (EWMA, range-based) log-return std. */
  std: number;
}

/**
 * EWMA log-return stats from candles. Volatility is the square root of an
 * EWMA-weighted Garman-Klass per-bar variance (uses O/H/L/C); drift is the
 * EWMA-weighted mean of close-to-close log-returns. More recent bars carry
 * exponentially more weight (decay `lambda`). Exported for the feature
 * extractor (vol-regime feature) so both share one estimator.
 */
export function returnStats(
  candles: Candle[],
  lambda = EWMA_LAMBDA
): ReturnStats {
  const n = candles.length;
  if (n < 2) return { mean: 0, std: 0 };

  // Garman-Klass per-bar variance: 0.5*(ln H/L)^2 - (2ln2-1)*(ln C/O)^2.
  const TWO_LN2_MINUS_1 = 2 * Math.LN2 - 1;
  let wSum = 0;
  let varSum = 0; // EWMA of GK variance
  let meanSum = 0; // EWMA of close-to-close log returns
  let prevClose = candles[0]!.close;

  for (let i = 0; i < n; i++) {
    const c = candles[i]!;
    // Weight: newest bar weight 1, older bars decayed by lambda^age.
    const w = Math.pow(lambda, n - 1 - i);
    if (c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0) {
      const hl = Math.log(c.high / c.low);
      const co = Math.log(c.close / c.open);
      const gk = 0.5 * hl * hl - TWO_LN2_MINUS_1 * co * co;
      varSum += w * Math.max(gk, 0);
    }
    if (i > 0 && prevClose > 0 && c.close > 0) {
      meanSum += w * Math.log(c.close / prevClose);
    }
    prevClose = c.close;
    wSum += w;
  }

  const variance = wSum > 0 ? varSum / wSum : 0;
  const mean = wSum > 0 ? meanSum / wSum : 0;
  return { mean, std: Math.sqrt(Math.max(variance, 0)) };
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
  const minute = returnStats(inputs.minuteCandles);
  const hour = returnStats(inputs.hourCandles);

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

/**
 * The per-minute volatility the model would use for a horizon. Exposed so the
 * feature extractor normalizes distance-to-strike by the SAME sigma that
 * produced the raw probability.
 */
export function sigmaPerMinFor(model: Model, horizonMinutes: number): number {
  return statsFor(model, horizonMinutes).std;
}

/**
 * Effective cumulative drift over a horizon: shrink the raw drift toward zero
 * and cap it as a fraction of diffusion (sigmaSum), so noisy trailing drift can
 * never dominate the probability. Returns the drift in log-space to add to the
 * mean of the horizon return distribution.
 */
function effectiveDrift(rawDriftSum: number, sigmaSum: number): number {
  const shrunk = rawDriftSum * DRIFT_SHRINK;
  if (sigmaSum <= 0) return shrunk;
  const cap = DRIFT_CAP_SIGMAS * sigmaSum;
  return Math.max(-cap, Math.min(cap, shrunk));
}

export function predictAbove(
  model: Model,
  strike: number,
  horizonMinutes: number,
  targetTime: string
): AbovePrediction {
  const { mean, std } = statsFor(model, horizonMinutes);
  const sigmaSum = std * Math.sqrt(horizonMinutes);
  const driftSum = effectiveDrift(mean * horizonMinutes, sigmaSum);
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
  const sigmaSum = std * Math.sqrt(horizonMinutes);
  const driftSum = effectiveDrift(mean * horizonMinutes, sigmaSum);
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
