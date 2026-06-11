// Commit-time feature extraction for the learned probability layer.
//
// The raw statistical model is (deliberately) driftless, so its directional
// call reduces to "is spot above or below the strike" — calibration alone can
// shape confidence but almost never flips a side. These features give the
// per-family learner (calibration.ts) real signal to learn DIRECTION from:
//
//   z        distance-to-strike in vol units (the raw model's own signal,
//            signed — kept so the learner can re-weight it)
//   m*       momentum over several lookbacks, vol-normalized
//   vr       volatility regime: log ratio of fast vs slow EWMA vol
//   tod/dow  time-of-day (intraday) or day-of-week (daily) seasonality
//   mkt      logit of the Polymarket implied up-probability, when quoted
//
// Every feature is clamped to a small range so a bad input can never blow up
// the logistic fit, and a missing input contributes exactly 0 (the prior).
// Features are FROZEN onto the committed call / ledger entry at commit time, so
// training rows always reflect what was actually known at decision time.

import type { Candle } from '../sources/binance.ts';
import { returnStats } from './forecast.ts';
import type { RangeId } from '../../shared/types.ts';

const MIN = 60_000;
const HOUR = 3_600_000;

const clamp = (x: number, lim: number) =>
  Number.isFinite(x) ? Math.max(-lim, Math.min(lim, x)) : 0;
const logit = (p: number) =>
  Math.log(
    Math.min(1 - 1e-4, Math.max(1e-4, p)) /
      (1 - Math.min(1 - 1e-4, Math.max(1e-4, p)))
  );

/**
 * Feature keys per family, in canonical order. The learner's weight vector is
 * aligned with this order, so the keys double as the model schema; adding a
 * key later is safe (old rows read 0 for it).
 */
export const FEATURE_KEYS: Record<RangeId, string[]> = {
  '5m': ['z', 'm15', 'm60', 'm240', 'vr', 'todSin', 'todCos', 'mkt'],
  '15m': ['z', 'm15', 'm60', 'm240', 'vr', 'todSin', 'todCos', 'mkt'],
  '1h': ['z', 'm15', 'm60', 'm240', 'vr', 'todSin', 'todCos', 'mkt'],
  '4h': ['z', 'm15', 'm60', 'm240', 'vr', 'todSin', 'todCos', 'mkt'],
  '1d': ['z', 'm1d', 'm3d', 'm7d', 'vr', 'dowSin', 'dowCos', 'mkt'],
};

export interface FeatureInputs {
  family: RangeId;
  /** Decision-time price (spot live; first 1m close in backfill). */
  price: number;
  /** Price to beat at the window open. */
  strike: number;
  /** Minutes remaining until the window resolves. */
  horizonMinutes: number;
  /** Per-minute sigma the model used for this horizon (sigmaPerMinFor). */
  sigmaPerMin: number;
  /** Trailing 1m candles available at decision time (ascending). */
  minuteCandles: Candle[];
  /** Trailing 1h candles available at decision time (ascending). */
  hourCandles: Candle[];
  /** Polymarket implied P(up) at decision time, when a market is quoted. */
  marketImpliedUp?: number;
  /** Decision instant (epoch ms). */
  now: number;
}

/** Close of the latest candle opening at or before `t`, or undefined. */
function closeAtOrBefore(candles: Candle[], t: number): number | undefined {
  let best: Candle | undefined;
  for (const c of candles) {
    if (c.openTime <= t && (!best || c.openTime > best.openTime)) best = c;
  }
  return best?.close;
}

/** Vol-normalized log-return from `lookbackMs` ago to now: ln(p/p₋ₖ)/(σ·√k). */
function momentum(
  price: number,
  candles: Candle[],
  now: number,
  lookbackMs: number,
  sigmaPerBar: number,
  barMs: number
): number {
  const past = closeAtOrBefore(candles, now - lookbackMs);
  if (!past || past <= 0 || price <= 0 || sigmaPerBar <= 0) return 0;
  const bars = lookbackMs / barMs;
  return clamp(Math.log(price / past) / (sigmaPerBar * Math.sqrt(bars)), 4);
}

/** Log ratio of fast vs slow EWMA vol — positive when vol is expanding. */
function volRegime(candles: Candle[]): number {
  if (candles.length < 30) return 0;
  const fast = returnStats(candles, 0.9).std;
  const slow = returnStats(candles, 0.99).std;
  if (fast <= 0 || slow <= 0) return 0;
  return clamp(Math.log(fast / slow), 2);
}

/** Extract the frozen feature record for one family at decision time. */
export function extractFeatures(inp: FeatureInputs): Record<string, number> {
  const {
    family,
    price,
    strike,
    horizonMinutes,
    sigmaPerMin,
    minuteCandles,
    hourCandles,
    marketImpliedUp,
    now,
  } = inp;

  const sigmaSum = sigmaPerMin * Math.sqrt(Math.max(horizonMinutes, 1 / 60));
  const z =
    strike > 0 && price > 0 && sigmaSum > 0
      ? clamp(Math.log(price / strike) / sigmaSum, 4)
      : 0;
  const mkt = marketImpliedUp != null ? clamp(logit(marketImpliedUp), 3) : 0;

  if (family === '1d') {
    const sigmaHr = returnStats(hourCandles).std;
    const angle = (2 * Math.PI * new Date(now).getUTCDay()) / 7;
    return {
      z,
      m1d: momentum(price, hourCandles, now, 24 * HOUR, sigmaHr, HOUR),
      m3d: momentum(price, hourCandles, now, 72 * HOUR, sigmaHr, HOUR),
      m7d: momentum(price, hourCandles, now, 168 * HOUR, sigmaHr, HOUR),
      vr: volRegime(hourCandles),
      dowSin: Math.sin(angle),
      dowCos: Math.cos(angle),
      mkt,
    };
  }

  const sigmaMin = returnStats(minuteCandles).std;
  const d = new Date(now);
  const hourFloat = d.getUTCHours() + d.getUTCMinutes() / 60;
  const angle = (2 * Math.PI * hourFloat) / 24;
  return {
    z,
    m15: momentum(price, minuteCandles, now, 15 * MIN, sigmaMin, MIN),
    m60: momentum(price, minuteCandles, now, 60 * MIN, sigmaMin, MIN),
    m240: momentum(price, minuteCandles, now, 240 * MIN, sigmaMin, MIN),
    vr: volRegime(minuteCandles),
    todSin: Math.sin(angle),
    todCos: Math.cos(angle),
    mkt,
  };
}
