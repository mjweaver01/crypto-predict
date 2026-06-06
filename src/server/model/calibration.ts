// Learned calibration: the loop that makes the model "get better as it sees
// more outcomes". We fit a per-range mapping from the model's RAW probability to
// the empirically observed win frequency, using resolved committed calls from
// the ledger, then apply it to new predictions.
//
// Method: Platt scaling in logit space — calibrated logit = a * rawLogit + b.
//   • a < 1 shrinks overconfident probabilities toward 0.5.
//   • b corrects a directional / base-rate bias.
// Fit with regularized (ridge) Newton steps whose L2 prior pulls (a, b) toward
// the identity (1, 0). With little data the fit stays ≈ identity, so calibration
// can only help once enough outcomes accumulate; it never wildly distorts a
// thin sample.
//
// We deliberately fit on the RAW probability (stored separately in the ledger),
// not the already-calibrated one, so the training signal stays stationary as the
// calibrator evolves — otherwise it would keep correcting its own corrections.

import { env } from '../cache.ts';
import { getLedger } from './ledger.ts';
import type { CalibrationInfo, RangeId } from '../../shared/types.ts';

export interface Calibrator {
  /** Slope on the logit. */
  a: number;
  /** Intercept on the logit. */
  b: number;
  /** Number of resolved samples the fit used. */
  n: number;
}

const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '1d'];

/** Below this many resolved calls we don't calibrate at all (stay identity). */
const MIN_SAMPLES = Math.max(1, Number(env('CALIB_MIN_SAMPLES', '25')) || 25);
/** L2 prior strength pulling (a, b) toward identity. Higher ⇒ more shrinkage. */
const PRIOR = Math.max(0, Number(env('CALIB_PRIOR', '10')) || 10);

const IDENTITY: Calibrator = { a: 1, b: 0, n: 0 };

const EPS = 1e-4;
const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

const cache: Record<RangeId, Calibrator> = {
  '5m': IDENTITY,
  '15m': IDENTITY,
  '1h': IDENTITY,
  '1d': IDENTITY,
};

/** Map a raw probability through a calibrator. Identity is a no-op fast path. */
export function applyCalibration(p: number, cal: Calibrator): number {
  if (cal.n === 0) return p;
  return clampP(sigmoid(cal.a * logit(clampP(p)) + cal.b));
}

/** The calibrator currently in force for a range. */
export function getCalibrator(id: RangeId): Calibrator {
  return cache[id];
}

/** Display-friendly summary of a range's calibrator. */
export function calibrationInfo(id: RangeId): CalibrationInfo {
  const cal = cache[id];
  return { samples: cal.n, active: cal.n > 0 };
}

/**
 * Fit a (raw → calibrated) Platt mapping by regularized Newton's method on the
 * logistic log-loss with an L2 prior centered at the identity (a=1, b=0).
 */
function fit(samples: { p: number; y: number }[]): Calibrator {
  if (samples.length < MIN_SAMPLES) return IDENTITY;

  let a = 1;
  let b = 0;
  for (let iter = 0; iter < 50; iter++) {
    let g0 = 0; // ∂/∂a
    let g1 = 0; // ∂/∂b
    let h00 = 0;
    let h01 = 0;
    let h11 = 0;
    for (const s of samples) {
      const z = logit(clampP(s.p));
      const ph = sigmoid(a * z + b);
      const r = ph - s.y;
      g0 += r * z;
      g1 += r;
      const w = ph * (1 - ph);
      h00 += w * z * z;
      h01 += w * z;
      h11 += w;
    }
    // L2 prior toward identity (1, 0): penalty PRIOR*((a-1)^2 + b^2).
    g0 += 2 * PRIOR * (a - 1);
    g1 += 2 * PRIOR * b;
    h00 += 2 * PRIOR;
    h11 += 2 * PRIOR;

    const det = h00 * h11 - h01 * h01;
    if (Math.abs(det) < 1e-12) break;
    const da = (h11 * g0 - h01 * g1) / det;
    const db = (h00 * g1 - h01 * g0) / det;
    a -= da;
    b -= db;
    if (Math.abs(da) + Math.abs(db) < 1e-9) break;
  }

  // Guard against a degenerate fit (e.g. perfectly separable thin data).
  if (!Number.isFinite(a) || !Number.isFinite(b)) return IDENTITY;
  return { a, b, n: samples.length };
}

/**
 * Refit every range's calibrator from the resolved ledger. Only entries that
 * carry a RAW probability (i.e. recorded under the committed-call regime) are
 * used, so older contaminated rows can't poison the fit. Cheap enough to run on
 * the resolve cadence.
 */
export async function refreshCalibrators(): Promise<void> {
  let entries;
  try {
    entries = await getLedger();
  } catch (err) {
    console.warn('[calibration] refresh failed to load ledger:', err);
    return;
  }
  for (const id of RANGE_IDS) {
    const samples = entries
      .filter(
        e =>
          e.rangeId === id &&
          e.outcome != null &&
          typeof e.rawProbUp === 'number'
      )
      .map(e => ({ p: e.rawProbUp as number, y: e.outcome === 'UP' ? 1 : 0 }));
    cache[id] = fit(samples);
  }
}
