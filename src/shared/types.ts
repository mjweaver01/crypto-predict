// Shared types used by both server and client.

import type { CryptoId } from './cryptos.ts';

/** The recurring Polymarket Up/Down market families we mirror as tabs. */
export type RangeId = '5m' | '15m' | '1h' | '4h' | '1d';

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
  /**
   * Stable id: `${crypto}:${rangeId}:${windowStartMs}`. Legacy rows recorded
   * before multi-crypto support use `${rangeId}:${windowStartMs}` (= btc).
   */
  id: string;
  /** Asset of the market. Absent on legacy rows (= btc). */
  crypto?: CryptoId;
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
  /**
   * Tradable CLOB prices for the UP token captured at commit time: the bet we
   * grade is only as real as the price we could have executed at. Buying Up
   * costs `marketAskUp`; buying Down costs `1 - marketBidUp`.
   */
  marketBidUp?: number;
  marketAskUp?: number;
  /**
   * Commit-time book depth (top levels with sizes, best first) — lets the
   * paper replay fill realistically instead of assuming unlimited size at the
   * touch. Absent on rows recorded before depth capture existed.
   */
  marketUpBids?: BookLevel[];
  marketUpAsks?: BookLevel[];
  /** ISO time the commit-time order book was read (staleness audit). */
  marketQuotedAt?: string;
  /**
   * Where the tradable prices came from: a live order-book snapshot at commit,
   * or a backfill from real executed fills early in the window (conservative —
   * worst fill price — but still an approximation of the commit-instant book).
   */
  bookSource?: 'live' | 'trades';
  /**
   * Commit-time feature record (see server features.ts) frozen with the call —
   * the inputs the learned layer trains on. Absent on legacy rows.
   */
  features?: Record<string, number>;
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
  /** Asset the tick belongs to (absent on legacy frames = btc). */
  crypto?: CryptoId;
  /** Latest trade price (USDT). */
  price: number;
  /** Rolling 24h % change at the time of the tick. */
  change24hPct: number;
  /** epoch ms of the tick (Binance event time). */
  t: number;
}

/**
 * One visible order-book level: price `p` (0..1) and size `s` in shares.
 * Field names are short because these are persisted per ledger row.
 */
export interface BookLevel {
  p: number;
  s: number;
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
  /** Best bid for the UP token (0..1) — the price you could SELL Up at. */
  upBestBid?: number;
  /** Best ask for the UP token (0..1) — the price you could BUY Up at. */
  upBestAsk?: number;
  /**
   * Top visible UP-token book levels (best first), WITH sizes — what a fill
   * could actually consume. The paper layer walks these instead of pretending
   * unlimited depth at the touch.
   */
  upBids?: BookLevel[];
  upAsks?: BookLevel[];
  /** ISO time the order book was read, to audit staleness vs commit time. */
  quotedAt?: string;
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
  /** Commit-time feature record frozen with the call (learner training row). */
  features?: Record<string, number>;
  /** ISO time the call was committed (≈ window open). */
  decidedAt: string;
  /** Minutes left in the window at the moment we committed. */
  horizonMinutes: number;
  /**
   * Tradable CLOB prices for the UP token frozen with the call. The paper bet
   * is priced off these — never off a later (less forward-looking) book.
   */
  marketBidUp?: number;
  marketAskUp?: number;
  /** Frozen commit-time book depth (top levels with sizes, best first). */
  marketUpBids?: BookLevel[];
  marketUpAsks?: BookLevel[];
}

/**
 * The EV layer's verdict on a committed call: whether the frozen probability
 * beats the frozen tradable price by enough to be worth a (paper) bet, and how
 * much of the bankroll fractional Kelly would stake on it.
 */
export interface PaperDecision {
  action: 'BET' | 'PASS';
  /** Side the bet would take (the committed side). */
  side: Side;
  /** Cost (0..1) per $1 of payout at the frozen book, when computable. */
  cost?: number;
  /** Model probability of `side` minus `cost`. */
  edge?: number;
  /** Fraction of bankroll staked (fractional Kelly, capped). 0 when PASS. */
  stakeFraction: number;
  /**
   * Dollars staked at the current paper bankroll (stakeFraction × bankroll),
   * matching the stake the replay's open bet carries. Only set on live BETs.
   */
  stake?: number;
  /** Why a PASS passed: no book at commit, or edge below the minimum. */
  reason?: 'no-book' | 'edge-below-min';
}

/** Paper-trading policy (env-tunable); echoed in the API for transparency. */
export interface PaperPolicy {
  startBankroll: number;
  /**
   * Minimum edge (probability − cost) required to take a bet, per family.
   * Families with unproven tradable edge carry a higher bar.
   */
  minEdge: Record<RangeId, number>;
  /** Fraction of full Kelly actually staked (e.g. 0.25 = quarter-Kelly). */
  kellyFraction: number;
  /** Hard cap on the fraction of bankroll staked on any single bet. */
  maxStakeFraction: number;
  /**
   * Hard DOLLAR cap per bet — models market capacity. Without it the
   * compounding replay grows stakes past anything the book could fill and the
   * equity curve becomes fiction.
   */
  maxStakeUsd: number;
  /** Max price deterioration past the touch a fill may walk into the book. */
  fillSlippage: number;
  /** Stake used by the non-compounding flat-stake scoreboard. */
  flatStakeUsd: number;
  /**
   * Polymarket taker fee (basis points) applied to every cost/edge/P&L
   * computation. All BTC up/down families currently charge 1000 (10%).
   */
  takerFeeBps: number;
}

/** One simulated bet in the paper-trading replay. */
export interface PaperBet {
  id: string;
  rangeId: RangeId;
  decidedAt: string;
  windowEnd: string;
  side: Side;
  /**
   * Effective cost (0..1) per $1 of payout: the depth-weighted average fill
   * price from walking the commit-time book (top-of-book on legacy rows
   * without stored depth).
   */
  cost: number;
  /** True when visible depth capped the stake below what Kelly wanted. */
  depthCapped?: boolean;
  /** Model probability of the side taken, frozen at commit. */
  pSide: number;
  edge: number;
  /** Dollars staked (bankroll × stake fraction at the time of the bet). */
  stake: number;
  /** Realized profit/loss in dollars; undefined while the window is open. */
  pnl?: number;
  bankrollAfter?: number;
  won?: boolean;
}

export interface PaperFamilyStats {
  rangeId: RangeId;
  bets: number;
  wins: number;
  staked: number;
  pnl: number;
  /** pnl / staked. */
  roi: number;
}

export interface PaperResponse {
  policy: PaperPolicy;
  summary: {
    bankroll: number;
    pnl: number;
    /** pnl / total staked (return on turnover). */
    roi: number;
    /** Worst peak-to-trough bankroll loss, as a fraction of the peak. */
    maxDrawdown: number;
    bets: number;
    wins: number;
    /** Resolved real-book calls that failed the min-edge test. */
    passes: number;
    /** Resolved real-book calls scored (bets + passes). */
    evaluated: number;
    /** Where evaluated rows' tradable prices came from. */
    sources: { live: number; trades: number };
    /**
     * Non-compounding scoreboard: the same bets at a fixed small stake. This
     * is the number to extrapolate from — it can't inflate itself by
     * compounding into sizes the book never held.
     */
    flat: { stakeUsd: number; staked: number; pnl: number; roi: number };
  };
  families: PaperFamilyStats[];
  /** Bankroll after each resolved bet, for the equity curve. */
  equity: { t: number; bankroll: number }[];
  /** All resolved bets, newest first. */
  bets: PaperBet[];
  /** Bets on still-open windows (stake priced at the current bankroll). */
  open: PaperBet[];
}

/**
 * Execution status of a real (or dry-run) Polymarket trade:
 *  - dry-run  → full decision path ran but no order was sent (shadow mode)
 *  - filled   → the FAK order filled completely
 *  - partial  → the FAK order filled partially (remainder cancelled)
 *  - unfilled → the order was accepted but matched nothing (book moved)
 *  - failed   → the CLOB rejected the order or the request errored
 */
export type TradeStatus =
  | 'dry-run'
  | 'filled'
  | 'partial'
  | 'unfilled'
  | 'failed';

/**
 * One real-money (or shadow) trade placed against a committed call. Persisted
 * to data/trades.json — unlike paper bets this is a record of EXECUTION, not a
 * replayable simulation, so fills/P&L are stored rather than recomputed.
 */
export interface TradeRecord {
  /** Window id `${crypto}:${rangeId}:${windowStartMs}` — one trade max per window. */
  id: string;
  /** Asset of the market (absent on legacy rows = btc). */
  crypto?: CryptoId;
  rangeId: RangeId;
  slug: string;
  windowStart: string;
  windowEnd: string;
  /** Side bought (the committed side). */
  side: Side;
  /** CLOB token id of the outcome token bought. */
  tokenId: string;
  /** Outcome index of `tokenId` in the market (0 = Up, 1 = Down). */
  outcomeIndex: number;
  /** CTF condition id, needed to redeem winning positions on-chain. */
  conditionId?: string;
  /** Whether the market trades on the neg-risk exchange (affects redemption). */
  negRisk?: boolean;
  /** Model probability of the side at decision time. */
  pSide: number;
  /** Edge (pSide − execution-time ask) that justified the trade. */
  edge: number;
  /** Best ask for the side token at execution time (raw, pre-fee). */
  quotedCost: number;
  /** Taker fee (bps) the market charged, from the CLOB at execution time. */
  feeBps?: number;
  /** Marketable-limit price cap actually sent. */
  limitPrice: number;
  /** USD the order intended to spend. */
  intendedUsd: number;
  status: TradeStatus;
  orderId?: string;
  /** USD actually spent (maker amount of the fill). */
  costUsd?: number;
  /** Outcome tokens received (taker amount of the fill). */
  shares?: number;
  /** costUsd / shares. */
  avgPrice?: number;
  error?: string;
  placedAt: string;

  // ── Filled in once the window resolves ──────────────────────────────
  outcome?: Side | null;
  won?: boolean;
  /** Realized P&L: shares − costUsd on a win, −costUsd on a loss. */
  pnlUsd?: number;
  settledAt?: string;
  /** On-chain redemption tx hash once winnings were claimed. */
  redeemTx?: string;
  redeemedAt?: string;

  // ── Fill verification (POST /api/trades/verify / bun run trade:verify) ──
  /** On-chain tx hash(es) for the fill(s), sourced from Polymarket data API. */
  fillTxHashes?: string[];
  /** Cost the data API reports for our fills (may differ slightly from costUsd). */
  verifiedCostUsd?: number;
  /** Shares the data API reports for our fills. */
  verifiedShares?: number;
  /** 'match' = recorded fill agrees with data API within tolerance. */
  verifyStatus?: 'match' | 'mismatch' | 'notfound' | 'error';
  /** Human-readable detail, e.g. "2 fills · Δcost $0.01" or error message. */
  verifyNote?: string;
  /** ISO timestamp of the last verification attempt. */
  verifiedAt?: string;
}

/** GET /api/trades — live-trading status and the execution record. */
export interface TradesResponse {
  enabled: boolean;
  dryRun: boolean;
  summary: {
    trades: number;
    open: number;
    settled: number;
    wins: number;
    /** Total USD spent across settled trades. */
    costUsd: number;
    /** Realized P&L across settled trades. */
    pnlUsd: number;
    /** Realized P&L for the current UTC day (drives the daily loss halt). */
    pnlTodayUsd: number;
    /** True when the daily loss limit has halted trading. */
    halted: boolean;
  };
  trades: TradeRecord[];
}

/**
 * A full prediction for one Polymarket BTC Up/Down family (one tab): the
 * window-anchored up/down odds, the price-to-beat, a price forecast for the
 * window end, and the live market quote when one exists.
 */
export interface RangePrediction {
  id: RangeId;
  /** Asset this window belongs to. */
  crypto: CryptoId;
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
  /** Current feature record feeding the learned layer (frozen on commit). */
  features?: Record<string, number>;
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
  /** EV verdict on the committed call (absent when nothing was committed). */
  paper?: PaperDecision;
}

/** Compact, display-friendly summary of a range's active calibrator. */
export interface CalibrationInfo {
  /** Number of resolved committed calls the calibrator was fit on. */
  samples: number;
  /** True once enough samples exist to actually shape the probability. */
  active: boolean;
}

/**
 * Prequential (online, out-of-sample) scores over a set of resolved committed
 * calls. `probUp` was produced by the learner in force at COMMIT time — i.e.
 * trained only on windows resolved before the call — so comparing it with the
 * frozen raw probability measures whether the learning loop is actually
 * helping, with no peeking.
 */
export interface MetricsBucket {
  /** Resolved calls scored. */
  n: number;
  /** Hit rate of the committed side. */
  accuracy: number;
  /** Mean Brier of the calibrated (bet-on) probability. Lower is better. */
  brierCal: number;
  /** Mean Brier of the frozen raw probability. */
  brierRaw: number;
  /** Mean Brier of the market-implied probability, over calls that had one. */
  brierMkt?: number;
  /** How many calls carried a market quote (brierMkt sample size). */
  nMkt: number;
}

/** One step of the rolling learning-curve series (windowed means). */
export interface MetricsPoint {
  /** Window-start epoch ms of the resolved call this step ends at. */
  t: number;
  brierCal: number;
  brierRaw: number;
  /** Rolling (last-N) hit rate. */
  accuracy: number;
  /** Cumulative hit rate from the first resolved call in the series. */
  cumAccuracy: number;
}

/** Learning metrics for one family (or the ALL aggregate). */
export interface FamilyMetrics {
  family: RangeId | 'ALL';
  overall: MetricsBucket;
  /** Last-`window` resolved calls. */
  rolling: MetricsBucket;
  /** Rolling window size used for `rolling` and `series`. */
  window: number;
  /** Rolling series over the resolved sequence (decimated for charting). */
  series: MetricsPoint[];
}

export interface MetricsResponse {
  families: FamilyMetrics[];
}

/**
 * A compact, point-in-time capture of the model's "read" (narrative and
 * directional calls) taken each time a fresh prediction is computed. Kept in
 * a windowed in-memory buffer so the UI can scroll back through how sentiment
 * evolved without persisting anything to disk.
 */
export interface InsightSnapshot {
  /** Asset the read was for (absent on legacy rows = btc). */
  crypto?: CryptoId;
  /** ISO timestamp the underlying prediction was generated. */
  asOf: string;
  /** Spot price at the time. */
  price: number;
  /** 24h % change at the time. */
  change24hPct: number;
  /** One-sentence model summary. */
  narrative: string;
  /** Per-range directional calls at the time. */
  calls: { id: RangeId; label: string; probUp: number; side: Side }[];
}

export interface Prediction {
  /** ISO timestamp the prediction was generated */
  asOf: string;
  /** Asset this prediction is for. */
  crypto: CryptoId;
  symbol: string;
  stats: MarketStats;
  /** One prediction per Polymarket market family, ordered shortest → longest. */
  ranges: RangePrediction[];
  /** One-sentence stats-grounded summary of the model's read. */
  narrative: string;
  /** Recent 1-minute price history (oldest → newest), for sparklines */
  history: PricePoint[];
  /**
   * Spot price series at several look-back windows (oldest → newest, live spot
   * appended), powering the range toggle on the hero chart. The `LIVE` view is
   * built client-side from the price stream, so it isn't included here.
   */
  spot: Record<ServerSpotRangeId, PricePoint[]>;
}
