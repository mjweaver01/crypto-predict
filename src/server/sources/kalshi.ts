// Kalshi market-data source (CFTC-regulated, US-legal alternative to
// Polymarket). Kalshi runs ONE recurring up/down family we can mirror: the
// 15-minute "price up or down" series, which exists for all six tracked
// assets (KXBTC15M, KXETH15M, KXSOL15M, KXXRP15M, KXDOGE15M, KXBNB15M).
// There is no 5m/4h equivalent, the hourly/daily series are fixed-strike
// above/below ladders (not up/down vs the window open), so on Kalshi only the
// 15m family carries a live market — the other families still predict and
// commit, they just have nothing to quote or trade against.
//
// Identifiers are deterministic, like Polymarket slugs:
//   event ticker   KXBTC15M-{YY}{MON}{DD}{HHMM}   (window END in ET, 24h)
//   market ticker  {event}-{MM}                   (close minute suffix)
// e.g. the 13:30–13:45 UTC window on Jun 12 2026 (= 9:45am ET close) is
// KXBTC15M-26JUN120945-45. One market per event.
//
// Everything resolves against CF Benchmarks' Real-Time Index: the strike is
// the average of the 60 RTI prices before the window OPEN — and unlike
// Polymarket it is exposed directly on the market record (floor_strike), so
// no proxy is needed. Market-data endpoints are public (no auth).

import { cached, env } from '../cache.ts';
import type { CryptoId } from '../../shared/cryptos.ts';
import type { BookLevel, MarketQuote, RangeId } from '../../shared/types.ts';

const API = env(
  'KALSHI_API_URL',
  'https://api.elections.kalshi.com/trade-api/v2'
);
const TTL = Number(env('CACHE_TTL_KALSHI', '5')); // seconds
const ET = 'America/New_York';

/** How many book levels per side we keep (matches the Polymarket source). */
const BOOK_DEPTH_LEVELS = 5;

/** Kalshi 15-minute up/down series per asset (verified live, June 2026). */
export const KALSHI_15M_SERIES: Record<CryptoId, string> = {
  btc: 'KXBTC15M',
  eth: 'KXETH15M',
  sol: 'KXSOL15M',
  xrp: 'KXXRP15M',
  doge: 'KXDOGE15M',
  bnb: 'KXBNB15M',
};

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bitcoin-predict/1.0' },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    const err = new Error(`kalshi ${res.status} ${url}`) as Error & {
      status?: number;
    };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];

/** ET calendar parts of an instant, for building event tickers. */
function etParts(ms: number) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: ET,
    year: '2-digit',
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find(p => p.type === t)?.value ?? '';
  return {
    yy: get('year'),
    mon: MONTHS[Number(get('month')) - 1] ?? 'JAN',
    dd: get('day'),
    hh: get('hour'),
    mm: get('minute'),
  };
}

/**
 * Deterministic Kalshi market ticker for a crypto + family + window, or null
 * for families Kalshi doesn't run as an up/down market. Keyed by the window
 * END (ET clock time of the close).
 */
export function marketTicker(
  crypto: CryptoId,
  rangeId: RangeId,
  windowEndMs: number
): string | null {
  if (rangeId !== '15m') return null;
  const { yy, mon, dd, hh, mm } = etParts(windowEndMs);
  return `${KALSHI_15M_SERIES[crypto]}-${yy}${mon}${dd}${hh}${mm}-${mm}`;
}

/** True when a market id is a Kalshi ticker rather than a Polymarket slug. */
export function isKalshiTicker(id: string): boolean {
  return /^KX[A-Z0-9]+-/.test(id);
}

interface KalshiMarket {
  ticker?: string;
  title?: string;
  status?: string;
  result?: string; // 'yes' | 'no' | '' until settled
  floor_strike?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  updated_time?: string;
}

/** One market by ticker, briefly cached, or null when it doesn't exist. */
export async function fetchMarketMeta(
  ticker: string
): Promise<KalshiMarket | null> {
  return cached(`kalshi:mkt:${ticker}`, TTL, async () => {
    try {
      const data = (await getJson(`${API}/markets/${ticker}`)) as {
        market?: KalshiMarket;
      };
      return data?.market ?? null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null; // window may not have a market (yet)
      throw err;
    }
  });
}

const toNum = (v: string | number | undefined): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
};

/**
 * Order book in UP-token orientation, best level first — the same shape the
 * Polymarket source produces, so everything downstream (depth-aware paper
 * fills, the executor's book walk) works unchanged.
 *
 * Kalshi's book holds resting YES buys and NO buys, each ascending with the
 * best level LAST. A resting NO buy at q is the liquidity a YES taker lifts at
 * 1−q, so: yes bids = yes levels reversed; yes asks = no levels mapped to 1−q
 * and reversed (which leaves them ascending from the best ask).
 */
export async function bookTop(ticker: string): Promise<
  | {
      bid?: number;
      ask?: number;
      bids: BookLevel[];
      asks: BookLevel[];
      quotedAt?: string;
    }
  | undefined
> {
  const data = (await getJson(`${API}/markets/${ticker}/orderbook`)) as {
    orderbook_fp?: {
      yes_dollars?: [string, string][];
      no_dollars?: [string, string][];
    };
  };
  const book = data?.orderbook_fp;
  const clean = (
    levels: [string, string][] | undefined,
    invert: boolean
  ): BookLevel[] =>
    (levels ?? [])
      .map(([p, s]) => ({
        // Round inverted prices: 1 − 0.66 carries float noise these levels
        // would otherwise persist into ledger rows.
        p: invert ? Math.round((1 - Number(p)) * 1e6) / 1e6 : Number(p),
        s: Number(s),
      }))
      .filter(
        l =>
          Number.isFinite(l.p) &&
          l.p > 0 &&
          l.p < 1 &&
          Number.isFinite(l.s) &&
          l.s > 0
      );
  const bids = clean(book?.yes_dollars, false)
    .sort((a, b) => b.p - a.p)
    .slice(0, BOOK_DEPTH_LEVELS);
  const asks = clean(book?.no_dollars, true)
    .sort((a, b) => a.p - b.p)
    .slice(0, BOOK_DEPTH_LEVELS);
  if (bids.length === 0 && asks.length === 0) return undefined;
  return {
    bid: bids[0]?.p,
    ask: asks[0]?.p,
    bids,
    asks,
    quotedAt: new Date().toISOString(),
  };
}

/**
 * Fetch a Kalshi up/down market by ticker and return the window bounds + live
 * implied odds, or null when no such market exists / Kalshi is down. Mirrors
 * the Polymarket fetchMarket contract: window bounds come from the caller.
 */
export async function fetchMarket(
  ticker: string,
  windowStartMs: number,
  windowEndMs: number
): Promise<MarketQuote | null> {
  return cached(`kalshi:quote:${ticker}`, TTL, async () => {
    const m = await fetchMarketMeta(ticker);
    if (!m) return null;

    const top = await bookTop(ticker).catch(() => undefined);
    const bid = top?.bid ?? toNum(m.yes_bid_dollars);
    const ask = top?.ask ?? toNum(m.yes_ask_dollars);
    const impliedUp =
      bid !== undefined && ask !== undefined
        ? (bid + ask) / 2
        : (bid ?? ask ?? toNum(m.last_price_dollars));
    if (impliedUp === undefined) return null;

    return {
      source: 'kalshi',
      slug: ticker,
      question: m.title ?? ticker,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      impliedUp,
      impliedDown: 1 - impliedUp,
      upBestBid: bid,
      upBestAsk: ask,
      upBids: top?.bids,
      upAsks: top?.asks,
      quotedAt: top?.quotedAt ?? new Date().toISOString(),
    };
  });
}

/**
 * The EXACT "price to beat" for a window: Kalshi publishes it as the market's
 * floor_strike (avg of the 60 CF Benchmarks RTI prices before the open), so
 * unlike Polymarket no separate strike API is needed. Undefined for families
 * Kalshi doesn't serve, or in the first moments of a window before the strike
 * lands on the record.
 */
export async function fetchKalshiStrike(
  rangeId: RangeId,
  windowEndMs: number,
  crypto: CryptoId = 'btc'
): Promise<number | undefined> {
  const ticker = marketTicker(crypto, rangeId, windowEndMs);
  if (!ticker) return undefined;
  const m = await fetchMarketMeta(ticker);
  const strike = Number(m?.floor_strike);
  return Number.isFinite(strike) && strike > 0 ? strike : undefined;
}

/**
 * Resolve a market ticker to its realized outcome, or null while unsettled.
 * Uncached (resolution polls until the result lands). For the 15m up/down
 * series YES means the window closed at-or-above its strike, i.e. "Up".
 */
export async function fetchMarketOutcome(
  ticker: string
): Promise<{ outcomeUp: number } | null> {
  let m: KalshiMarket | null;
  try {
    const data = (await getJson(`${API}/markets/${ticker}`)) as {
      market?: KalshiMarket;
    };
    m = data?.market ?? null;
  } catch {
    return null;
  }
  if (m?.result === 'yes') return { outcomeUp: 1 };
  if (m?.result === 'no') return { outcomeUp: 0 };
  return null;
}

/**
 * Kalshi's trading fee as a quadratic coefficient in basis points: the fee per
 * contract is rate · P · (1−P) (rounded up to the cent on the total), charged
 * in CASH on top of the price — not in shares like Polymarket. The standard
 * rate is 7% (700 bps); the series' fee_multiplier scales it. Falls back to
 * 700 so a fetch failure can never make a trade look cheaper than it is.
 */
export async function fetchFeeBps(seriesTicker: string): Promise<number> {
  return cached(`kalshi:fee:${seriesTicker}`, 3600, async () => {
    const data = (await getJson(`${API}/series/${seriesTicker}`)) as {
      series?: { fee_multiplier?: number };
    };
    const mult = Number(data?.series?.fee_multiplier);
    if (!Number.isFinite(mult) || mult < 0) throw new Error('fee unavailable');
    return Math.round(700 * mult);
  }).catch(() => 700);
}

/** Series ticker portion of a market ticker (`KXBTC15M-…` → `KXBTC15M`). */
export function seriesOf(ticker: string): string {
  return ticker.split('-')[0] ?? ticker;
}
