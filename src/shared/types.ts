// Shared types used by both server and client.

/** A single directional up/down prediction over a short horizon. */
export interface DirectionPrediction {
  horizonMinutes: number;
  /** 0..1 probability that price is higher at the end of the horizon */
  probUp: number;
  /** Convenience: 1 - probUp */
  probDown: number;
}

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

export interface Prediction {
  /** ISO timestamp the prediction was generated */
  asOf: string;
  symbol: string;
  stats: MarketStats;
  up5m: DirectionPrediction;
  up15m: DirectionPrediction;
  above: AbovePrediction;
  price: PriceForecast;
  /** One-sentence summary of the model's read */
  narrative: string;
  /** Optional 2-3 sentence LLM reasoning (absent on the pure-stats path) */
  reasoning?: string;
  /** True when an LLM provider nudged the directional probabilities */
  llmApplied: boolean;
}
