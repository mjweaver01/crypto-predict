// Learned probability layer: the loop that makes the model get better as it
// sees more outcomes. For each market family we fit a small RIDGE LOGISTIC
// REGRESSION from the model's raw probability PLUS commit-time features
// (features.ts) to the empirically observed win frequency, using resolved
// committed calls from the ledger:
//
//   calibrated logit = w0 · rawLogit + Σ wj · xj + b
//
// This strictly generalizes the old Platt scaling (w0=a, b=b, w=0):
//   • w0 < 1 shrinks overconfident probabilities toward 0.5.
//   • b corrects a directional / base-rate bias.
//   • wj let the learner discover real directional signal (momentum, vol
//     regime, market-implied odds, seasonality) — i.e. it can learn to FLIP a
//     marginal call, not just reshape its confidence.
//
// Fit details:
//   • L2 prior pulls (w0, w, b) toward the identity (1, 0, 0): with little
//     data the layer is a no-op and can only act once evidence accumulates.
//   • Samples are RECENCY-WEIGHTED with a per-family half-life so a fitted
//     regime bias decays instead of being carried forever by dilution.
//   • We always fit on the RAW probability + frozen commit-time features,
//     never the already-calibrated output, keeping the training signal
//     stationary as the learner evolves.
//   • Legacy rows without features still train the (w0, b) part — their
//     feature values read as 0, the prior mean.
//
// Every refit that materially changes a family's weights is appended to
// data/calibrators.jsonl so the learner's own evolution is auditable.

import { env } from '../cache.ts';
import { getLedger } from './ledger.ts';
import { FEATURE_KEYS } from './features.ts';
import { CRYPTO_IDS, type CryptoId } from '../../shared/cryptos.ts';
import type { CalibrationInfo, RangeId } from '../../shared/types.ts';

export interface Calibrator {
  /** Feature keys aligned with `w` (canonical order from features.ts). */
  keys: string[];
  /** Weight on logit(rawProbUp). Prior 1. */
  w0: number;
  /** Per-feature weights. Prior 0. */
  w: number[];
  /** Intercept. Prior 0. */
  b: number;
  /** Number of resolved samples the fit used. */
  n: number;
}

const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

/** Below this many resolved calls we don't fit at all (stay identity). */
const MIN_SAMPLES = Math.max(1, Number(env('CALIB_MIN_SAMPLES', '25')) || 25);
/** L2 prior strength pulling (w0, b) toward identity. Higher ⇒ more shrinkage. */
const PRIOR = Math.max(0, Number(env('CALIB_PRIOR', '10')) || 10);
/** L2 prior strength pulling feature weights toward 0. */
const FEATURE_PRIOR = Math.max(
  0,
  Number(env('CALIB_FEATURE_PRIOR', '10')) || 10
);

/**
 * Recency half-life per family (hours): a sample this old counts half as much.
 * Scaled to each family's cadence so fast families track the current regime
 * while slow families keep enough effective history to fit at all.
 */
const HALF_LIFE_HOURS: Record<RangeId, number> = {
  '5m': Number(env('CALIB_HALF_LIFE_HOURS_5M', '24')) || 24,
  '15m': Number(env('CALIB_HALF_LIFE_HOURS_15M', '48')) || 48,
  '1h': Number(env('CALIB_HALF_LIFE_HOURS_1H', '168')) || 168,
  '4h': Number(env('CALIB_HALF_LIFE_HOURS_4H', '336')) || 336,
  '1d': Number(env('CALIB_HALF_LIFE_HOURS_1D', '1440')) || 1440,
};

const HISTORY_PATH = env(
  'CALIBRATOR_HISTORY_PATH',
  `${process.cwd()}/data/calibrators.jsonl`
);

const identity = (id: RangeId): Calibrator => ({
  keys: FEATURE_KEYS[id],
  w0: 1,
  w: FEATURE_KEYS[id].map(() => 0),
  b: 0,
  n: 0,
});

const EPS = 1e-4;
const clampP = (p: number) => Math.min(1 - EPS, Math.max(EPS, p));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

// One calibrator per (crypto, family): each asset's regime bias is its own.
// Keys are `${crypto}:${rangeId}`; lookups fall back to identity until fit.
const cache = new Map<string, Calibrator>();

const calKey = (crypto: CryptoId, id: RangeId) => `${crypto}:${id}`;

/**
 * Map a raw probability + its commit-time features through a calibrator.
 * Identity (n=0) is a no-op fast path; missing feature keys read as 0.
 */
export function applyCalibration(
  p: number,
  features: Record<string, number> | undefined,
  cal: Calibrator
): number {
  if (cal.n === 0) return p;
  let z = cal.w0 * logit(clampP(p)) + cal.b;
  for (let j = 0; j < cal.keys.length; j++) {
    const x = features?.[cal.keys[j]!];
    if (typeof x === 'number' && Number.isFinite(x)) z += cal.w[j]! * x;
  }
  return clampP(sigmoid(z));
}

/** The calibrator currently in force for a crypto + range. */
export function getCalibrator(
  id: RangeId,
  crypto: CryptoId = 'btc'
): Calibrator {
  return cache.get(calKey(crypto, id)) ?? identity(id);
}

/** Display-friendly summary of a crypto + range's calibrator. */
export function calibrationInfo(
  id: RangeId,
  crypto: CryptoId = 'btc'
): CalibrationInfo {
  const cal = getCalibrator(id, crypto);
  return { samples: cal.n, active: cal.n > 0 };
}

/** Solve A·x = g for x (dense, partial pivoting). Returns null if singular. */
function solve(A: number[][], g: number[]): number[] | null {
  const d = g.length;
  const M = A.map((row, i) => [...row, g[i]!]);
  for (let col = 0; col < d; col++) {
    let piv = col;
    for (let r = col + 1; r < d; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv]!, M[col]!];
    for (let r = 0; r < d; r++) {
      if (r === col) continue;
      const f = M[r]![col]! / M[col]![col]!;
      for (let c = col; c <= d; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  return M.map((row, i) => row[d]! / M[i]![i]!);
}

interface Sample {
  /** logit of the raw probability. */
  z0: number;
  /** Feature vector aligned with FEATURE_KEYS[family] (missing → 0). */
  x: number[];
  /** Realized outcome: 1 = UP. */
  y: number;
  /** Recency weight in (0, 1]. */
  u: number;
}

/**
 * Fit by weighted ridge Newton's method on the logistic log-loss with an L2
 * prior centered at the identity (w0=1, w=0, b=0).
 * Parameter vector: θ = [w0, ...w, b].
 */
function fit(samples: Sample[], keys: string[]): Omit<Calibrator, 'keys'> {
  const k = keys.length;
  const d = k + 2;
  // θ0 = prior mean, lam = per-param prior strength.
  const theta = [1, ...new Array<number>(k).fill(0), 0];
  const theta0 = [...theta];
  const lam = [PRIOR, ...new Array<number>(k).fill(FEATURE_PRIOR), PRIOR];

  const phi = (s: Sample): number[] => [s.z0, ...s.x, 1];

  for (let iter = 0; iter < 50; iter++) {
    const g = new Array<number>(d).fill(0);
    const H = Array.from({ length: d }, () => new Array<number>(d).fill(0));
    for (const s of samples) {
      const f = phi(s);
      let zz = 0;
      for (let i = 0; i < d; i++) zz += theta[i]! * f[i]!;
      const ph = sigmoid(zz);
      const r = s.u * (ph - s.y);
      const w = s.u * ph * (1 - ph);
      for (let i = 0; i < d; i++) {
        g[i]! += r * f[i]!;
        for (let j = i; j < d; j++) H[i]![j]! += w * f[i]! * f[j]!;
      }
    }
    for (let i = 0; i < d; i++) {
      g[i]! += 2 * lam[i]! * (theta[i]! - theta0[i]!);
      H[i]![i]! += 2 * lam[i]!;
      for (let j = 0; j < i; j++) H[i]![j] = H[j]![i]!;
    }
    const step = solve(H, g);
    if (!step) break;
    let moved = 0;
    for (let i = 0; i < d; i++) {
      theta[i]! -= step[i]!;
      moved += Math.abs(step[i]!);
    }
    if (moved < 1e-9) break;
  }

  if (theta.some(t => !Number.isFinite(t))) {
    return { w0: 1, w: new Array<number>(k).fill(0), b: 0, n: 0 };
  }
  return {
    w0: theta[0]!,
    w: theta.slice(1, 1 + k),
    b: theta[d - 1]!,
    n: samples.length,
  };
}

// Last-logged rounded weights per family, to avoid spamming the history file.
const lastLogged: Record<string, string> = {};

/**
 * Append materially-changed calibrators to the on-disk history (JSONL). The
 * `family` field stays the bare range id for btc (continuity with the
 * pre-multi-crypto history) and `${crypto}:${rangeId}` for the rest.
 */
async function logCalibrator(id: string, cal: Calibrator): Promise<void> {
  const round = (x: number) => Math.round(x * 1000) / 1000;
  const compact = JSON.stringify({
    w0: round(cal.w0),
    b: round(cal.b),
    w: Object.fromEntries(cal.keys.map((key, j) => [key, round(cal.w[j]!)])),
    n: cal.n,
  });
  if (lastLogged[id] === compact) return;
  lastLogged[id] = compact;
  const line =
    JSON.stringify({
      t: new Date().toISOString(),
      family: id,
      ...JSON.parse(compact),
    }) + '\n';
  try {
    const file = Bun.file(HISTORY_PATH);
    const prev = (await file.exists()) ? await file.text() : '';
    await Bun.write(HISTORY_PATH, prev + line);
  } catch (err) {
    console.warn('[calibration] history log failed:', err);
  }
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
  const now = Date.now();
  for (const crypto of CRYPTO_IDS) {
    for (const id of RANGE_IDS) {
      const keys = FEATURE_KEYS[id];
      const halfLifeMs = HALF_LIFE_HOURS[id] * 3_600_000;
      const samples: Sample[] = entries
        .filter(
          e =>
            (e.crypto ?? 'btc') === crypto &&
            e.rangeId === id &&
            e.outcome != null &&
            typeof e.rawProbUp === 'number'
        )
        .map(e => {
          const age = Math.max(0, now - Date.parse(e.decidedAt));
          return {
            z0: logit(clampP(e.rawProbUp as number)),
            x: keys.map(key => {
              const v = e.features?.[key];
              return typeof v === 'number' && Number.isFinite(v) ? v : 0;
            }),
            y: e.outcome === 'UP' ? 1 : 0,
            u: Math.pow(0.5, age / halfLifeMs),
          };
        });
      const cal =
        samples.length < MIN_SAMPLES
          ? identity(id)
          : { keys, ...fit(samples, keys) };
      cache.set(calKey(crypto, id), cal);
      if (cal.n > 0) {
        void logCalibrator(crypto === 'btc' ? id : calKey(crypto, id), cal);
      }
    }
  }
}
