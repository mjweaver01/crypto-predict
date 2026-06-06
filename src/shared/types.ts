// Shared types used by both server and client.

/** The recurring Polymarket BTC Up/Down market families we mirror as tabs. */
export type RangeId = '5m' | '15m' | '1h' | '1d';

/** Probability that BTC is above a strike at a target time. */
export interface AbovePrediction {
  strike: number;
  /** ISO timestamp of the resolution moment */
  targetTime: string;
  horizonMinutes: number;
  /** 0..1 probability close > strike */
  probAbove: number;
}

/** A point forecast for the price itself at a target time, with a band. */
export interface PriceForecast {
  targetTime: string;
  horizonMinutes: number;
  /** Price to beat: the open of the window this forecast resolves into */
  startPrice: number;
  point: number;
  /** ~95% confidence interval */
  low: number;
  high: number;
}

/** Stats derived from recent price history, exposed for transparency. */
export interface MarketStats {
  /** Latest spot price (USDT) */
  price: number;
  /** Annualised-free: per-minute log-return mean (drift) */
  driftPerMin: number;
  /** Per-minute log-return volatility (sigma) */
  volPerMin: number;
  /** Per-hour log-return volatility, used for longer horizons */
  volPerHour: number;
  /** % change over the last 24h */
  change24hPct: number;
}

/** A single recent price sample, used to draw sparklines on the client. */
export interface PricePoint {
  /** epoch ms */
  t: number;
  price: number;
}

/** Live quote for the matching Polymarket "BTC Up or Down 5m" market. */
export interface MarketQuote {
  source: 'polymarket';
  /** Deterministic market slug, e.g. btc-updown-5m-1780721400 */
  slug: string;
  /** Human-readable question, e.g. "Bitcoin Up or Down - June 6, 12:50AM-12:55AM ET" */
  question: string;
  /** ISO start of the resolution window (the "price to beat" moment) */
  windowStart: string;
  /** ISO end of the resolution window (when it settles) */
  windowEnd: string;
  /** 0..1 market-implied probability of "Up" (CLOB midpoint) */
  impliedUp: number;
  /** Convenience: 1 - impliedUp */
  impliedDown: number;
}

/**
 * A full prediction for one Polymarket BTC Up/Down family (one tab): the
 * window-anchored up/down odds, the price-to-beat, a price forecast for the
 * window end, and the live market quote when one exists.
 */
export interface RangePrediction {
  id: RangeId;
  /** Short human label, e.g. "5 min", "Hourly". */
  label: string;
  /** What the real market settles against. */
  resolutionSource: 'chainlink' | 'binance';
  /**
   * True when `strike` is a proxy for a settlement price not exposed by any
   * public API (the Chainlink-resolved 5m/15m markets).
   */
  strikeIsProxy: boolean;
  /** Minutes remaining until this window resolves. */
  horizonMinutes: number;
  /** Model P(close ≥ strike) i.e. P(Up) at the window end, after LLM bias. */
  probUp: number;
  /** Convenience: 1 - probUp. */
  probDown: number;
  /** Price to beat: the price at the window open. */
  strike: number;
  /** ISO start of the window (the strike moment). */
  windowStart: string;
  /** ISO end of the window (resolution). */
  windowEnd: string;
  /** Point price forecast + 95% band at the window end. */
  forecast: PriceForecast;
  /** Live Polymarket quote for this exact window, when one exists. */
  market?: MarketQuote;
}

export interface Prediction {
  /** ISO timestamp the prediction was generated */
  asOf: string;
  symbol: string;
  stats: MarketStats;
  /** One prediction per Polymarket market family, ordered shortest → longest. */
  ranges: RangePrediction[];
  /** One-sentence summary of the model's read */
  narrative: string;
  /** Optional 2-3 sentence LLM reasoning (absent on the pure-stats path) */
  reasoning?: string;
  /** True when an LLM provider nudged the directional probabilities */
  llmApplied: boolean;
  /** Recent 1-minute price history (oldest → newest), for sparklines */
  history: PricePoint[];
}
