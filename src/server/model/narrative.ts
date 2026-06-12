// Stats-grounded narrative: a one-line description of the model's read,
// contrived from the same numbers the dashboard already shows (lead window's
// call, spot vs strike, drift, 24h change). This replaced the LLM-assist
// layer: the LLM's ±8-point nudge was never measurable against the structural
// signal (and the calibrator would absorb any consistent bias it added), so
// the narrative is the only part worth keeping — and it doesn't need a model.

import type { Model } from './forecast.ts';

/** One window's call, used to ground the narrative in concrete levels. */
export interface WindowRead {
  /** Human label, e.g. "5 min". */
  label: string;
  /** Minutes remaining at the read. */
  horizonMin: number;
  /** Price to beat at the window open. */
  strike: number;
  /** Model P(up) for the window. */
  probUp: number;
  /** Market-implied P(up), when a live market exists. */
  marketImpliedUp?: number;
}

export interface NarrativeContext {
  /** Pair label, e.g. "BTC/USDT". */
  asset?: string;
  /** Current spot price. */
  price: number;
  /** Per-window reads, shortest horizon first. */
  reads: WindowRead[];
}

const pct = (p: number) => Math.round(Math.max(p, 1 - p) * 100);
const dirOf = (p: number) => (p >= 0.5 ? 'UP' : 'DOWN');

/** The dashboard's one-sentence model read. */
export function buildNarrative(model: Model, ctx?: NarrativeContext): string {
  const { change24hPct, driftPerMin } = model.stats;
  const change = `${change24hPct >= 0 ? '+' : ''}${change24hPct.toFixed(2)}% on 24h`;
  const lead = ctx?.reads[0];
  if (lead && ctx) {
    const vs = ctx.price >= lead.strike ? 'above' : 'below';
    const strike = lead.strike.toLocaleString('en-US', {
      maximumFractionDigits: lead.strike >= 10 ? 0 : 4,
    });
    return (
      `Leaning ${dirOf(lead.probUp)} on the ${lead.label} (${pct(lead.probUp)}%): ` +
      `spot ${vs} the $${strike} strike, drift ${(driftPerMin * 1e4).toFixed(2)}bp/min, ${change}.`
    );
  }
  const dir = driftPerMin > 0 ? 'upward' : 'downward';
  const asset = ctx?.asset?.split('/')[0] ?? '';
  return `Near-flat read: ${dir} 1m drift of ${(driftPerMin * 1e4).toFixed(2)}bp/min, ${asset} ${change}.`;
}
