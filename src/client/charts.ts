// Dependency-free inline SVG charts, as pure string-producing functions. They
// are framework-agnostic on purpose: components render the returned markup via
// `dangerouslySetInnerHTML` and wire hover tooltips with attachChartTip. Keeping
// them as plain functions means none of the (intricate, well-tested) geometry
// changes during the Preact migration.

import type {
  FamilyMetrics,
  MetricsPoint,
  PricePoint,
  RangeId,
} from '../shared/types.ts';
import { COLORS, px } from './format.ts';

/** Last `mins` minutes of history (1 sample ≈ 1 minute, plus the live point). */
export function lastMinutes(history: PricePoint[], mins: number): PricePoint[] {
  return history.slice(-(mins + 1));
}

/** A price sparkline scaled to a 100x32 viewBox, with an optional strike line. */
export function sparkline(
  points: PricePoint[],
  color: string,
  opts: { strike?: number } = {}
): string {
  if (points.length < 2) return '<div class="chart-empty"></div>';
  const W = 100;
  const H = 32;
  const prices = points.map(p => p.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (opts.strike !== undefined) {
    min = Math.min(min, opts.strike);
    max = Math.max(max, opts.strike);
  }
  const pad = (max - min) * 0.12 || 1;
  min -= pad;
  max += pad;
  const t0 = points[0]!.t;
  const span = points[points.length - 1]!.t - t0 || 1;
  const X = (t: number) => ((t - t0) / span) * W;
  const Y = (p: number) => H - ((p - min) / (max - min)) * H;

  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${px(X(p.t))} ${px(Y(p.price))}`)
    .join(' ');
  const area = `${d} L ${px(W)} ${px(H)} L 0 ${px(H)} Z`;
  const strikeLine =
    opts.strike !== undefined
      ? `<line x1="0" y1="${px(Y(opts.strike))}" x2="${W}" y2="${px(Y(opts.strike))}" stroke="${COLORS.accent}" stroke-width="1" stroke-dasharray="3 2" opacity="0.8" vector-effect="non-scaling-stroke"/>`
      : '';

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" fill-opacity="0.12"/>
    ${strikeLine}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

export interface HeroRender {
  /** The chart SVG markup (or an empty-state placeholder). */
  svg: string;
  /** Live-dot position (viewBox %) + colour, or null when there's no line. */
  dot: { x: number; y: number; color: string } | null;
}

/**
 * Large Polymarket-style price chart: gradient area + line coloured by the
 * window's net direction. Drawn in a 0..100 viewBox that stretches to fill its
 * container (non-scaling stroke keeps the line crisp). The live dot is returned
 * separately so it can live in a persistent DOM node (its pulse animation must
 * not restart when the SVG is redrawn each animation frame).
 */
export function heroRender(points: PricePoint[]): HeroRender {
  if (points.length < 2) {
    return { svg: '<div class="chart-empty"></div>', dot: null };
  }
  const prices = points.map(p => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const t0 = points[0]!.t;
  const span = points[points.length - 1]!.t - t0 || 1;
  const PAD = 8; // vertical breathing room (viewBox units)
  const X = (t: number) => ((t - t0) / span) * 100;
  const Y = (p: number) => PAD + (1 - (p - min) / range) * (100 - 2 * PAD);

  const up = prices[prices.length - 1]! >= prices[0]!;
  const color = up ? COLORS.up : COLORS.down;
  const gid = up ? 'heroUp' : 'heroDown';

  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${px(X(p.t))} ${px(Y(p.price))}`)
    .join(' ');
  const area = `${d} L 100 100 L 0 100 Z`;
  const last = points[points.length - 1]!;

  const svg = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;

  return { svg, dot: { x: X(last.t), y: Y(last.price), color } };
}

/** Two comparison bars: market-implied vs our model probability of Up. */
export function compareBars(marketUp: number, modelUp: number): string {
  const fmtPctLocal = (v: number) => `${(v * 100).toFixed(1)}%`;
  const row = (label: string, v: number, color: string) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:11px;">
      <span style="width:56px;color:var(--text-dim);">${label}</span>
      <div style="flex:1;height:8px;border-radius:5px;background:rgba(255,255,255,0.05);overflow:hidden;">
        <div style="height:100%;width:${(v * 100).toFixed(1)}%;background:${color};transition:width .4s ease;"></div>
      </div>
      <span style="width:44px;text-align:right;font-variant-numeric:tabular-nums;">${fmtPctLocal(v)}</span>
    </div>`;
  return `<div style="display:flex;flex-direction:column;gap:8px;">
    ${row('Market', marketUp, COLORS.accent)}
    ${row('Model', modelUp, modelUp >= 0.5 ? COLORS.up : COLORS.down)}
  </div>`;
}

// How much 1m history to show per range (longer windows get more context).
export const CHART_MINUTES: Record<RangeId, number> = {
  '5m': 30,
  '15m': 90,
  '1h': 120,
  '4h': 120,
  '1d': 120,
};

/** X positions (viewBox %) for n evenly spaced points, matching the charts'
 *  PADX=1.5 layout, so tooltip snapping lands exactly on the drawn points. */
export const seriesXs = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => 1.5 + (i / Math.max(1, n - 1)) * 97);

export const isoOf = (t: number) => new Date(t).toISOString();

/**
 * Rolling Brier of the calibrated (bet-on) probability vs the frozen raw
 * model probability, against the 0.25 coin-flip baseline. The gap between the
 * two lines is the learned layer's real out-of-sample contribution.
 */
export function learningChart(f: FamilyMetrics): string {
  const pts = f.series;
  if (pts.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  // Y spans the data plus the 0.25 baseline so the dashed line is always shown.
  const vals = pts.flatMap(p => [p.brierCal, p.brierRaw]).concat(0.25);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 0.02);
  const lastIdx = pts.length - 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (v: number) =>
    PADTOP + (1 - (v - lo) / span) * (H - PADTOP - PADBOT);

  const line = (key: 'brierCal' | 'brierRaw') =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`).join(' ');

  const yBase = px(Y(0.25));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yBase}" x2="${W}" y2="${yBase}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line('brierRaw')}" fill="none" stroke="${COLORS.muted}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" vector-effect="non-scaling-stroke"/>
    <path d="${line('brierCal')}" fill="none" stroke="${COLORS.accent}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Generic value-over-sequence line vs a dashed baseline (equity / cum P&L). */
export function paperChart(values: number[], baseline: number): string {
  if (values.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  const all = values.concat(baseline);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(hi - lo, 1e-9);
  const lastIdx = values.length - 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (v: number) =>
    PADTOP + (1 - (v - lo) / span) * (H - PADTOP - PADBOT);

  const line = values
    .map((v, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(v))}`)
    .join(' ');
  const yBase = px(Y(baseline));
  const color =
    values[values.length - 1]! >= baseline ? COLORS.up : COLORS.down;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yBase}" x2="${W}" y2="${yBase}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/**
 * Inline SVG line chart of accuracy over time, drawn from the metrics series:
 * a cumulative hit rate (overall trend) and a rolling hit rate (recent form),
 * against a dashed 50% baseline. The series is already date-filtered and covers
 * the full window (not just the current ledger page).
 */
export function hitRateChartFromSeries(pts: MetricsPoint[]): string {
  if (pts.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  const lastIdx = pts.length - 1 || 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (a: number) => PADTOP + (1 - a) * (H - PADTOP - PADBOT);

  const line = (key: 'cumAccuracy' | 'accuracy') =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`).join(' ');

  const yMid = px(Y(0.5));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yMid}" x2="${W}" y2="${yMid}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line('cumAccuracy')}" fill="none" stroke="${COLORS.muted}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" vector-effect="non-scaling-stroke"/>
    <path d="${line('accuracy')}" fill="none" stroke="${COLORS.accent}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}
