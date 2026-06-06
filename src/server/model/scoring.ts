// Proper scoring rules for probabilistic binary forecasts, plus a reliability
// (calibration) curve. Used by the backtest harness to compare model variants
// against simple baselines.

export interface Scored {
  /** Number of (probability, outcome) pairs scored. */
  n: number;
  /** Mean Brier score = mean (p - y)^2. Lower is better; 0.25 = always 0.5. */
  brier: number;
  /** Mean log-loss (natural log). Lower is better; ln2 ≈ 0.693 = always 0.5. */
  logLoss: number;
  /** Fraction of outcomes that were "up" (the base rate). */
  baseRate: number;
  /** Accuracy when thresholding at 0.5. */
  accuracy: number;
}

const EPS = 1e-6;

/** Score aligned arrays of predicted up-probabilities and {0,1} outcomes. */
export function score(probs: number[], outcomes: number[]): Scored {
  const n = Math.min(probs.length, outcomes.length);
  if (n === 0) {
    return { n: 0, brier: NaN, logLoss: NaN, baseRate: NaN, accuracy: NaN };
  }
  let brier = 0;
  let logLoss = 0;
  let ups = 0;
  let correct = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - EPS, Math.max(EPS, probs[i]!));
    const y = outcomes[i]!;
    brier += (p - y) ** 2;
    logLoss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
    ups += y;
    if ((p >= 0.5 ? 1 : 0) === y) correct++;
  }
  return {
    n,
    brier: brier / n,
    logLoss: logLoss / n,
    baseRate: ups / n,
    accuracy: correct / n,
  };
}

export interface ReliabilityBin {
  /** Inclusive lower / exclusive upper probability edge of the bin. */
  lo: number;
  hi: number;
  /** Count of predictions in the bin. */
  n: number;
  /** Mean predicted probability in the bin. */
  meanPred: number;
  /** Observed frequency of "up" in the bin (the empirical probability). */
  observed: number;
}

/**
 * Reliability curve: bucket predictions into `bins` equal-width probability
 * bins and compare mean predicted vs observed frequency. A well-calibrated
 * model has meanPred ≈ observed in every bin.
 */
export function reliability(
  probs: number[],
  outcomes: number[],
  bins = 10
): ReliabilityBin[] {
  const acc = Array.from({ length: bins }, () => ({ n: 0, sumP: 0, sumY: 0 }));
  const n = Math.min(probs.length, outcomes.length);
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - EPS, Math.max(0, probs[i]!));
    const b = Math.min(bins - 1, Math.floor(p * bins));
    acc[b]!.n++;
    acc[b]!.sumP += p;
    acc[b]!.sumY += outcomes[i]!;
  }
  return acc.map((a, i) => ({
    lo: i / bins,
    hi: (i + 1) / bins,
    n: a.n,
    meanPred: a.n ? a.sumP / a.n : NaN,
    observed: a.n ? a.sumY / a.n : NaN,
  }));
}
