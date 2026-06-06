import { cached, env } from '../cache.ts';

// data-api.binance.vision is Binance's public market-data mirror: same
// /api/v3/* endpoints and BTCUSDT data, but no API key and no geo-block (the
// main api.binance.com returns HTTP 451 in some regions, e.g. the US).
export const BASE = env('BINANCE_BASE_URL', 'https://data-api.binance.vision');
const SYMBOL = env('BTC_SYMBOL', 'BTCUSDT');
const TTL = Number(env('CACHE_TTL_KLINES', '20')); // seconds

/** A single OHLC candle + open time. High/low enable range-based volatility. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Binance REST returns klines as arrays:
 *   [openTime, open, high, low, close, volume, closeTime, ...]
 * The resolution source for the Polymarket BTC markets is Binance BTC/USDT,
 * so we read directly from the same place those markets settle against.
 */
type RawKline = [number, string, string, string, string, ...unknown[]];

/** Map a raw Binance kline tuple to a typed OHLC candle. */
export function toCandle(k: RawKline): Candle {
  return {
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
  };
}

export async function fetchCandles(
  interval: '1m' | '5m' | '1h',
  limit: number
): Promise<Candle[]> {
  return cached(`klines:${interval}:${limit}`, TTL, async () => {
    const url = `${BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'bitcoin-predict/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`binance klines ${res.status}`);
    const raw = (await res.json()) as RawKline[];
    return raw.map(toCandle);
  });
}

/**
 * Fetch the single candle whose openTime is exactly `openTimeMs` for an
 * interval, or null if Binance doesn't have it yet. Used to pin a window's
 * exact boundary price (the "price to beat") instead of relying on whatever
 * happens to be cached. Cached briefly since a past candle never changes.
 */
export async function fetchCandleAt(
  interval: '1m' | '5m' | '1h',
  openTimeMs: number
): Promise<Candle | null> {
  return cached(`kline-at:${interval}:${openTimeMs}`, TTL, async () => {
    const url =
      `${BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}` +
      `&startTime=${openTimeMs}&limit=1`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'bitcoin-predict/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`binance kline-at ${res.status}`);
    const raw = (await res.json()) as RawKline[];
    if (raw.length === 0) return null;
    const c = toCandle(raw[0]!);
    return c.openTime === openTimeMs ? c : null;
  });
}

/**
 * Fetch all klines over [startMs, endMs) with pagination (Binance caps each
 * call at 1000). Uncached — intended for backtests / historical analysis.
 */
export async function fetchKlineRange(
  interval: '1m' | '5m' | '1h',
  startMs: number,
  endMs: number
): Promise<Candle[]> {
  const stepMs = { '1m': 60_000, '5m': 300_000, '1h': 3_600_000 }[interval];
  const out: Candle[] = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const url =
      `${BASE}/api/v3/klines?symbol=${SYMBOL}&interval=${interval}` +
      `&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'bitcoin-predict/1.0' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`binance klines ${res.status}`);
    const raw = (await res.json()) as RawKline[];
    if (raw.length === 0) break;
    for (const k of raw) out.push(toCandle(k));
    cursor = raw[raw.length - 1]![0] + stepMs;
    if (raw.length < 1000) break;
  }
  return out;
}

/** Latest spot price. */
export async function fetchPrice(): Promise<number> {
  return cached('price', TTL, async () => {
    const url = `${BASE}/api/v3/ticker/price?symbol=${SYMBOL}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'bitcoin-predict/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`binance price ${res.status}`);
    const data = (await res.json()) as { price: string };
    return parseFloat(data.price);
  });
}

/** 24h rolling price change percent. */
export async function fetch24hChangePct(): Promise<number> {
  return cached('change24h', TTL, async () => {
    const url = `${BASE}/api/v3/ticker/24hr?symbol=${SYMBOL}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'bitcoin-predict/1.0' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`binance 24hr ${res.status}`);
    const data = (await res.json()) as { priceChangePercent: string };
    return parseFloat(data.priceChangePercent);
  });
}

export const TRADING_SYMBOL = SYMBOL;
