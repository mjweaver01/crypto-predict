import { cached, env } from '../cache.ts';
import type { MarketQuote, RangeId } from '../../shared/types.ts';

// Polymarket runs five recurring "BTC Up or Down" market families:
//   5m     → slug btc-updown-5m-{startUnix}        (Chainlink BTC/USD)
//   15m    → slug btc-updown-15m-{startUnix}       (Chainlink BTC/USD)
//   4h     → slug btc-updown-4h-{startUnix}        (Chainlink BTC/USD)
//   hourly → slug bitcoin-up-or-down-{m}-{d}-{y}-{h}{am|pm}-et (Binance 1h candle)
//   daily  → slug bitcoin-up-or-down-on-{m}-{d}-{y}            (Binance 1m close @ noon ET)
//
// Gamma exposes the market/metadata; CLOB exposes live order-book prices. The
// settlement "price to beat" is never in the payload, so the caller supplies
// the window bounds (and its own strike proxy).
const GAMMA = env('POLYMARKET_GAMMA_URL', 'https://gamma-api.polymarket.com');
const CLOB = env('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com');
// Polymarket's own web API exposes the exact settlement "open" (price to beat)
// for the Chainlink-resolved 5m/15m/4h markets via /api/crypto/crypto-price.
const SITE = env('POLYMARKET_SITE_URL', 'https://polymarket.com');
const TTL = Number(env('CACHE_TTL_POLYMARKET', '5')); // seconds
const ET = 'America/New_York';

interface GammaMarket {
  question?: string;
  outcomes?: string; // JSON string, e.g. '["Up","Down"]'
  clobTokenIds?: string; // JSON string of token id strings
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bitcoin-predict/1.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw new Error(`polymarket ${res.status} ${url}`);
  return res.json();
}

/** CLOB midpoint (0..1) for a token, or undefined if unavailable. */
async function midpoint(tokenId: string): Promise<number | undefined> {
  const data = (await getJson(`${CLOB}/midpoint?token_id=${tokenId}`)) as {
    mid?: string;
  };
  const mid = data?.mid ? Number(data.mid) : NaN;
  return Number.isFinite(mid) ? mid : undefined;
}

interface ClobBookLevel {
  price?: string;
  size?: string;
}

/**
 * Best bid/ask (0..1) for a token from the CLOB order book — the prices a bet
 * could actually execute at, unlike the midpoint. Levels are scanned for the
 * extremes rather than trusting order. `quotedAt` is the book's own timestamp.
 */
async function bookTop(
  tokenId: string
): Promise<{ bid?: number; ask?: number; quotedAt?: string } | undefined> {
  const data = (await getJson(`${CLOB}/book?token_id=${tokenId}`)) as {
    timestamp?: string | number;
    bids?: ClobBookLevel[];
    asks?: ClobBookLevel[];
  };
  const best = (
    levels: ClobBookLevel[] | undefined,
    pick: (a: number, b: number) => number
  ): number | undefined => {
    let out: number | undefined;
    for (const l of levels ?? []) {
      const p = Number(l.price);
      if (!Number.isFinite(p) || p <= 0 || p >= 1) continue;
      out = out === undefined ? p : pick(out, p);
    }
    return out;
  };
  const bid = best(data.bids, Math.max);
  const ask = best(data.asks, Math.min);
  if (bid === undefined && ask === undefined) return undefined;
  const ts = Number(data.timestamp);
  return {
    bid,
    ask,
    quotedAt:
      Number.isFinite(ts) && ts > 0 ? new Date(ts).toISOString() : undefined,
  };
}

/** ET calendar parts for an instant, used to build human-dated slugs. */
function etParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === t)?.value ?? '';
  return {
    month: get('month').toLowerCase(),
    day: get('day'),
    year: get('year'),
    hour: get('hour'),
    ampm: get('dayPeriod').toLowerCase(),
  };
}

/** Deterministic Polymarket slug for each market family + window. */
export const slugFor = {
  '5m': (startMs: number) => `btc-updown-5m-${Math.floor(startMs / 1000)}`,
  '15m': (startMs: number) => `btc-updown-15m-${Math.floor(startMs / 1000)}`,
  '1h': (startMs: number) => {
    const { month, day, year, hour, ampm } = etParts(startMs);
    return `bitcoin-up-or-down-${month}-${day}-${year}-${hour}${ampm}-et`;
  },
  '4h': (startMs: number) => `btc-updown-4h-${Math.floor(startMs / 1000)}`,
  // The daily market is keyed by its RESOLUTION day (the closing noon ET).
  '1d': (endMs: number) => {
    const { month, day, year } = etParts(endMs);
    return `bitcoin-up-or-down-on-${month}-${day}-${year}`;
  },
};

// crypto-price `variant` query value per family. Only the Chainlink-resolved
// 5m/15m/4h markets are served from this endpoint; hourly/daily proxy Binance
// (and 451 from most regions), so we settle those off our own Binance candles.
const CRYPTO_PRICE_VARIANT: Partial<Record<RangeId, string>> = {
  '5m': 'fiveminute',
  '15m': 'fifteen',
  '4h': 'fourhour',
};

/** Polymarket's ISO format for crypto-price (whole seconds, trailing Z). */
function isoSec(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

/**
 * The EXACT "price to beat" Polymarket shows for a Chainlink-resolved window
 * (5m/15m/4h), read from their crypto-price API's `openPrice`. This is the
 * same Chainlink BTC/USD value the market settles against, so it removes the
 * Binance↔Chainlink basis that plagued our 1m-open proxy. Returns undefined for
 * families this endpoint doesn't serve, or if it's unavailable.
 */
export async function fetchPolymarketStrike(
  rangeId: RangeId,
  windowStartMs: number,
  windowEndMs: number
): Promise<number | undefined> {
  const variant = CRYPTO_PRICE_VARIANT[rangeId];
  if (!variant) return undefined;
  const url =
    `${SITE}/api/crypto/crypto-price?symbol=BTC` +
    `&eventStartTime=${isoSec(windowStartMs)}` +
    `&variant=${variant}` +
    `&endDate=${isoSec(windowEndMs)}`;
  // Throw on failure so `cached` never stores a bad/undefined strike (it can
  // serve a prior good one instead) and the caller falls back to its proxy.
  return cached(`pmstrike:${rangeId}:${windowStartMs}`, TTL, async () => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const data = (await getJson(url)) as { openPrice?: number };
        const open = Number(data?.openPrice);
        if (Number.isFinite(open) && open > 0) return open;
        lastErr = new Error(`crypto-price openPrice missing for ${variant}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  });
}

/**
 * Fetch a Polymarket BTC Up/Down market by slug and return the window bounds +
 * live implied odds, or null if no such market exists / Polymarket is down.
 * Window bounds are supplied by the caller since Gamma's startDate is the
 * listing time, not the resolution boundary.
 */
export async function fetchMarket(
  slug: string,
  windowStartMs: number,
  windowEndMs: number
): Promise<MarketQuote | null> {
  return cached(`polymarket:${slug}`, TTL, async () => {
    let market: GammaMarket;
    try {
      market = (await getJson(`${GAMMA}/markets/slug/${slug}`)) as GammaMarket;
    } catch {
      return null; // window may not have a market yet (too far out)
    }
    if (!market || !market.clobTokenIds || !market.outcomes) return null;

    let outcomes: string[];
    let tokenIds: string[];
    try {
      outcomes = JSON.parse(market.outcomes) as string[];
      tokenIds = JSON.parse(market.clobTokenIds) as string[];
    } catch {
      return null;
    }

    const upIdx = outcomes.findIndex(o => o.toLowerCase() === 'up');
    if (upIdx < 0 || !tokenIds[upIdx]) return null;

    // Prefer the order book: it yields the tradable bid/ask AND the midpoint in
    // one call. Fall back to the midpoint endpoint when the book is empty.
    const top = await bookTop(tokenIds[upIdx]).catch(() => undefined);
    const impliedUp =
      top?.bid !== undefined && top?.ask !== undefined
        ? (top.bid + top.ask) / 2
        : await midpoint(tokenIds[upIdx]).catch(() => undefined);
    if (impliedUp === undefined) return null;

    return {
      source: 'polymarket',
      slug,
      question: market.question ?? slug,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      impliedUp,
      impliedDown: 1 - impliedUp,
      upBestBid: top?.bid,
      upBestAsk: top?.ask,
      quotedAt: top?.quotedAt ?? new Date().toISOString(),
    };
  });
}

// ── Historical helpers (uncached) — used by the ensemble backtest ──────────

export interface ResolvedMarket {
  /** CLOB token id for the "Up" outcome. */
  upTokenId: string;
  /** Realized outcome: 1 if the market resolved Up, 0 if Down. */
  outcomeUp: number;
}

/**
 * Resolve a market slug to its "Up" token id and realized outcome, or null if
 * it doesn't exist or hasn't settled to a definitive 0/1. Uncached.
 */
export async function fetchMarketOutcome(
  slug: string
): Promise<ResolvedMarket | null> {
  let m: (GammaMarket & { outcomePrices?: string; closed?: boolean }) | null;
  try {
    m = (await getJson(`${GAMMA}/markets/slug/${slug}`)) as typeof m;
  } catch {
    return null;
  }
  if (!m || !m.closed || !m.outcomes || !m.clobTokenIds || !m.outcomePrices) {
    return null;
  }
  let outcomes: string[];
  let tokenIds: string[];
  let prices: string[];
  try {
    outcomes = JSON.parse(m.outcomes) as string[];
    tokenIds = JSON.parse(m.clobTokenIds) as string[];
    prices = JSON.parse(m.outcomePrices) as string[];
  } catch {
    return null;
  }
  const upIdx = outcomes.findIndex(o => o.toLowerCase() === 'up');
  if (upIdx < 0 || !tokenIds[upIdx]) return null;
  const upPrice = Number(prices[upIdx]);
  if (upPrice !== 0 && upPrice !== 1) return null; // not a clean resolution
  return { upTokenId: tokenIds[upIdx], outcomeUp: upPrice };
}

/** A single historical CLOB price point: unix seconds + price (0..1). */
export interface PricePointRaw {
  t: number;
  p: number;
}

/** Fetch the full CLOB midpoint price history for a token. Uncached. */
export async function fetchPriceHistory(
  tokenId: string
): Promise<PricePointRaw[]> {
  const url = `${CLOB}/prices-history?market=${tokenId}&interval=max&fidelity=1`;
  let data: { history?: PricePointRaw[] };
  try {
    data = (await getJson(url)) as { history?: PricePointRaw[] };
  } catch {
    return [];
  }
  return Array.isArray(data?.history) ? data.history : [];
}
