// Stats-grounded model read: a headline sentence plus a longer paragraph,
// contrived from the same numbers the dashboard already shows.

import type { MarketStats, RangeId, RangePrediction, Side } from './types.ts';

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
  /** Per-window reads; the lead read (index 0) drives the sentence. */
  reads: WindowRead[];
}

/** Range fields needed for the long-form description paragraph. */
export interface RangeDetail {
  id: RangeId;
  label: string;
  horizonMin: number;
  strike: number;
  probUp: number;
  rawProbUp: number;
  strikeIsProxy: boolean;
  resolutionSource: 'chainlink' | 'binance';
  windowStart: string;
  windowEnd: string;
  forecast: { point: number; low: number; high: number };
  committed?: {
    side: Side;
    probUp: number;
    confidence: number;
    decidedAt: string;
    horizonMinutes: number;
  };
  calibration?: { active: boolean; samples: number };
  market?: {
    impliedUp: number;
    upBestBid?: number;
    upBestAsk?: number;
  };
  paper?: {
    action: 'BET' | 'PASS';
    side: Side;
    cost?: number;
    edge?: number;
    stakeFraction: number;
    stake?: number;
    reason?: 'no-book' | 'edge-below-min';
  };
}

export interface DescriptionContext {
  asset?: string;
  price: number;
  range: RangeDetail;
}

const pct = (p: number) => Math.round(Math.max(p, 1 - p) * 100);
const pct1 = (p: number) => `${(p * 100).toFixed(1)}%`;
const dirOf = (p: number) => (p >= 0.5 ? 'UP' : 'DOWN');
const cents = (v: number) => `${(v * 100).toFixed(1)}¢`;

const fmtUsd = (n: number) =>
  n >= 10
    ? `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
    : `$${n.toFixed(2)}`;

const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

const fmtRemaining = (min: number) => {
  if (min < 1) return 'under a minute';
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
};

/** Map a prediction range into the slimmer shape the description builder uses. */
export function toRangeDetail(r: RangePrediction): RangeDetail {
  return {
    id: r.id,
    label: r.label,
    horizonMin: r.horizonMinutes,
    strike: r.strike,
    probUp: r.probUp,
    rawProbUp: r.rawProbUp,
    strikeIsProxy: r.strikeIsProxy,
    resolutionSource: r.resolutionSource,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    forecast: r.forecast,
    committed: r.committed
      ? {
          side: r.committed.side,
          probUp: r.committed.probUp,
          confidence: r.committed.confidence,
          decidedAt: r.committed.decidedAt,
          horizonMinutes: r.committed.horizonMinutes,
        }
      : undefined,
    calibration: r.calibration,
    market: r.market
      ? {
          impliedUp: r.market.impliedUp,
          upBestBid: r.market.upBestBid,
          upBestAsk: r.market.upBestAsk,
        }
      : undefined,
    paper: r.paper
      ? {
          action: r.paper.action,
          side: r.paper.side,
          cost: r.paper.cost,
          edge: r.paper.edge,
          stakeFraction: r.paper.stakeFraction,
          stake: r.paper.stake,
          reason: r.paper.reason,
        }
      : undefined,
  };
}

/** The dashboard's one-sentence model read. */
export function buildNarrative(
  stats: Pick<MarketStats, 'change24hPct' | 'driftPerMin'>,
  ctx?: NarrativeContext
): string {
  const { change24hPct, driftPerMin } = stats;
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

function calibrationClause(r: RangeDetail): string {
  if (!r.calibration?.active) {
    const n = r.calibration?.samples ?? 0;
    return n
      ? ` (${pct1(r.rawProbUp)} raw; calibrator still warming up on ${n} calls)`
      : ` (${pct1(r.rawProbUp)} raw; uncalibrated)`;
  }
  const delta = Math.round((r.probUp - r.rawProbUp) * 100);
  if (delta === 0) {
    return ` (${pct1(r.rawProbUp)} raw; no calibrator adjustment on ${r.calibration.samples} calls)`;
  }
  return (
    ` (${pct1(r.rawProbUp)} raw; ${delta > 0 ? '+' : ''}${delta} pts from ` +
    `${r.calibration.samples} past calls)`
  );
}

function marketClause(r: RangeDetail): string {
  const m = r.market;
  if (!m) return 'No live Polymarket quote for this window.';

  const wagerUp = r.committed?.probUp ?? r.probUp;
  const basis = r.committed ? 'committed' : 'live';
  const side = wagerUp >= 0.5 ? 'UP' : 'DOWN';
  const cost =
    side === 'UP'
      ? m.upBestAsk
      : m.upBestBid !== undefined
        ? 1 - m.upBestBid
        : undefined;

  if (cost !== undefined && cost > 0 && cost < 1) {
    const pSide = side === 'UP' ? wagerUp : 1 - wagerUp;
    const edge = pSide - cost;
    return (
      `Polymarket prices Up at ${pct1(m.impliedUp)}; our ${basis} read shows ` +
      `${edge >= 0 ? '+' : ''}${cents(edge)} tradable edge on ${side} (costs ${cents(cost)}).`
    );
  }

  const edge = wagerUp - m.impliedUp;
  return (
    `Polymarket prices Up at ${pct1(m.impliedUp)}; edge vs our ${basis} read is ` +
    `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts.`
  );
}

function paperClause(r: RangeDetail): string | null {
  const pd = r.paper;
  if (!pd) return null;
  if (pd.action === 'BET') {
    const edgeText = pd.edge !== undefined ? ` (+${cents(pd.edge)} edge)` : '';
    const costText = pd.cost !== undefined ? ` at ${cents(pd.cost)} cost` : '';
    const stakeText =
      pd.stake !== undefined
        ? `, staking ${fmtUsd(pd.stake)} (${(pd.stakeFraction * 100).toFixed(1)}% bankroll)`
        : `, staking ${(pd.stakeFraction * 100).toFixed(1)}% bankroll`;
    return `Paper policy: bet ${pd.side}${costText}${edgeText}${stakeText}.`;
  }
  const why =
    pd.reason === 'no-book'
      ? 'no order book at commit'
      : pd.reason === 'edge-below-min'
        ? 'edge below minimum'
        : 'insufficient edge';
  return `Paper policy: no bet (${why}).`;
}

function resolutionNote(r: RangeDetail, ticker: string): string | null {
  if (r.strikeIsProxy) {
    return `Strike is a Binance-open proxy; resolves on Chainlink ${ticker}/USD.`;
  }
  if (r.resolutionSource === 'chainlink') {
    return `Resolves on Chainlink ${ticker}/USD at Polymarket's price to beat.`;
  }
  if (r.id === '1d') {
    return `Resolves on the Binance ${ticker}/USDT 1m close at noon ET vs the prior noon.`;
  }
  return `Resolves on the Binance ${ticker}/USDT 1h candle (close vs open).`;
}

/** A longer stats-grounded paragraph for the active window. */
export function buildDescription(
  stats: Pick<MarketStats, 'change24hPct' | 'driftPerMin' | 'volPerHour'>,
  ctx: DescriptionContext
): string {
  const { range: r, price } = ctx;
  const ticker = ctx.asset?.split('/')[0] ?? 'BTC';
  const delta = price - r.strike;
  const vs = delta >= 0 ? 'above' : 'below';
  const deltaAbs = Math.abs(delta);
  const deltaStr =
    deltaAbs >= 10 ? fmtUsd(deltaAbs) : `$${deltaAbs.toFixed(2)}`;

  const parts: string[] = [];

  parts.push(
    `For the ${r.label} window (${fmtClock(r.windowStart)}–${fmtClock(r.windowEnd)}, ` +
      `${fmtRemaining(r.horizonMin)} left), spot at ${fmtUsd(price)} sits ${deltaStr} ` +
      `${vs} the ${fmtUsd(r.strike)} price to beat.`
  );

  parts.push(
    `The model assigns ${pct1(r.probUp)} to Up${calibrationClause(r)} and forecasts ` +
      `a close near ${fmtUsd(r.forecast.point)} (95% band ${fmtUsd(r.forecast.low)}–` +
      `${fmtUsd(r.forecast.high)}).`
  );

  if (r.committed) {
    const c = r.committed;
    parts.push(
      `We committed ${c.side} at ${fmtClock(c.decidedAt)} with ` +
        `${fmtRemaining(c.horizonMinutes)} on the clock (${pct1(c.confidence)} confidence).`
    );
  } else {
    parts.push('No call was committed for this window.');
  }

  parts.push(marketClause(r));

  const paper = paperClause(r);
  if (paper) parts.push(paper);

  const res = resolutionNote(r, ticker);
  if (res) parts.push(res);

  const change = `${stats.change24hPct >= 0 ? '+' : ''}${stats.change24hPct.toFixed(2)}%`;
  parts.push(
    `Underlying drift is ${(stats.driftPerMin * 1e4).toFixed(2)}bp/min at ` +
      `σ ${(stats.volPerHour * 100).toFixed(2)}%/h; ${ticker} is ${change} over 24h.`
  );

  return parts.join(' ');
}
