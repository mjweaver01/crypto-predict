// Shared types used by both server and client.

/** The recurring Polymarket BTC Up/Down market families we mirror as tabs. */
export type RangeId = '5m' | '15m' | '1h' | '1d';

/**
 * Selectable look-back windows for the spot price chart (shortest → longest).
 * `LIVE` is a client-only view built from streamed ticks (last ~1 minute); the
 * rest are precomputed server-side from candles.
 */
export type SpotRangeId = 'LIVE' | '1H' | '6H' | '1D' | '1W';

/** The look-back windows the server precomputes (everything but the live buffer). */
export type ServerSpotRangeId = Exclude<SpotRangeId, 'LIVE'>;

/** A directional call: which side we picked. */
export type Side = 'UP' | 'DOWN';

/**
 * One row of our prediction track record: the directional "bet" we made for a
 * window and, once it closes, what actually happened. Persisted to disk so we
 * accumulate a verifiable history of calls vs outcomes.
 */
export interface LedgerEntry {
  /** Stable id: `${rangeId}:${windowStartMs}`. */
  id: string;
  rangeId: RangeId;
  /** Polymarket slug for this window, when known. */
  slug?: string;
  windowStart: string;
  windowEnd: string;
  /** Price to beat at the window open. */
  strike: number;
  /** Up-probability frozen at commit time (after LLM bias + calibration). */
  probUp: number;
  /** RAW up-probability before calibration; the signal we fit the calibrator on. */
  rawProbUp?: number;
  /** Our pick: UP if probUp >= 0.5 else DOWN. */
  side: Side;
  /** Confidence = max(probUp, 1 - probUp). */
  confidence: number;
  /** Market-implied Up captured at commit time, if a live market existed. */
  marketImpliedUp?: number;
  /** Minutes left in the window at the moment we committed the call. */
  horizonMinutes: number;
  /** ISO time the call was committed (≈ window open, frozen thereafter). */
  decidedAt: string;
  /** How the outcome was determined once resolved. */
  source?: 'live' | 'backfill';

  // ── Filled in once the window resolves ──────────────────────────────
  /** Realized direction, or null while still open. */
  outcome?: Side | null;
  /** Settlement price used to resolve (close at window end). */
  closePrice?: number;
  /** Whether our pick matched the outcome. */
  correct?: boolean | null;
  /** Where the outcome came from: the real market, or a Binance proxy. */
  resolvedBy?: 'polymarket' | 'binance';
  /** ISO time the outcome was recorded. */
  resolvedAt?: string;
}

/** Aggregate stats over a set of resolved ledger entries. */
export interface LedgerSummary {
  total: number;
  resolved: number;
  correct: number;
  /** Hit rate over resolved entries. */
  accuracy: number;
  /** Mean Brier score over resolved entries. */
  brier: number;
  /** Per-range breakdown. */
  byRange: Record<
    RangeId,
    { resolved: number; correct: number; accuracy: number }
  >;
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

/**
 * A live spot tick streamed to the client (Server-Sent Events), sourced from the
 * Binance BTC/USDT websocket. Powers the real-time hero price without re-running
 * a full prediction on every update.
 */
export interface PriceTick {
  /** Latest trade price (USDT). */
  price: number;
  /** Rolling 24h % change at the time of the tick. */
  change24hPct: number;
  /** epoch ms of the tick (Binance event time). */
  t: number;
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
 * The directional call we locked in early in a window and will NOT change until
 * the window resolves. This is the "bet" we actually grade — frozen while the
 * horizon was still long, before price action near expiry reveals the outcome.
 * Distinct from the live `probUp`, which legitimately converges toward 0/1 as
 * the window runs out.
 */
export interface CommittedCall {
  /** Frozen up-probability at the moment we committed (after calibration). */
  probUp: number;
  /**
   * Frozen RAW model up-probability before calibration. This is what we fit the
   * calibrator on — keeping it separate from `probUp` keeps the training signal
   * stationary as the calibrator itself evolves (no double-correction).
   */
  rawProbUp: number;
  /** Frozen pick: UP if probUp >= 0.5 else DOWN. */
  side: Side;
  /** Frozen confidence = max(probUp, 1 - probUp). */
  confidence: number;
  /** Price to beat captured at commit time. */
  strike: number;
  /** ISO time the call was committed (≈ window open). */
  decidedAt: string;
  /** Minutes left in the window at the moment we committed. */
  horizonMinutes: number;
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
  /**
   * P(Up) at the window end, after LLM bias AND learned calibration. This is the
   * number we display and bet on.
   */
  probUp: number;
  /** RAW P(Up) before calibration (post LLM bias). Used to fit the calibrator. */
  rawProbUp: number;
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
  /**
   * The frozen directional call for this window, locked in early (while the
   * horizon was long) and unchanged thereafter. Absent only when the window was
   * first observed too late to make a genuine forward-looking call.
   */
  committed?: CommittedCall;
  /** How the learned calibrator is currently shaping this range's probability. */
  calibration?: CalibrationInfo;
  /** Live Polymarket quote for this exact window, when one exists. */
  market?: MarketQuote;
}

/** Compact, display-friendly summary of a range's active calibrator. */
export interface CalibrationInfo {
  /** Number of resolved committed calls the calibrator was fit on. */
  samples: number;
  /** True once enough samples exist to actually shape the probability. */
  active: boolean;
}

/**
 * A compact, point-in-time capture of the model's "read" (narrative, reasoning,
 * and directional calls) taken each time a fresh prediction is computed. Kept in
 * a windowed in-memory buffer so the UI can scroll back through how sentiment
 * evolved without persisting anything to disk.
 */
export interface InsightSnapshot {
  /** ISO timestamp the underlying prediction was generated. */
  asOf: string;
  /** Spot price at the time. */
  price: number;
  /** 24h % change at the time. */
  change24hPct: number;
  /** One-sentence model summary. */
  narrative: string;
  /** Optional 2-3 sentence LLM reasoning. */
  reasoning?: string;
  /** True when an LLM provider nudged the probabilities. */
  llmApplied: boolean;
  /** Per-range directional calls at the time. */
  calls: { id: RangeId; label: string; probUp: number; side: Side }[];
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
  /**
   * Spot price series at several look-back windows (oldest → newest, live spot
   * appended), powering the range toggle on the hero chart. The `LIVE` view is
   * built client-side from the price stream, so it isn't included here.
   */
  spot: Record<ServerSpotRangeId, PricePoint[]>;
}
