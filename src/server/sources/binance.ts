import { cached, env } from '../cache.ts';

// data-api.binance.vision is Binance's public market-data mirror: same
// /api/v3/* endpoints and BTCUSDT data, but no API key and no geo-block (the
// main api.binance.com returns HTTP 451 in some regions, e.g. the US).
const BASE = env('BINANCE_BASE_URL', 'https://data-api.binance.vision');
const SYMBOL = env('BTC_SYMBOL', 'BTCUSDT');
const TTL = Number(env('CACHE_TTL_KLINES', '20')); // seconds

/** A single candle: open/close prices + open time. */
export interface Candle {
  openTime: number;
  open: number;
  close: number;
}

/**
 * Binance REST returns klines as arrays:
 *   [openTime, open, high, low, close, volume, closeTime, ...]
 * The resolution source for the Polymarket BTC markets is Binance BTC/USDT,
 * so we read directly from the same place those markets settle against.
 */
type RawKline = [number, string, string, string, string, ...unknown[]];

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
    return raw.map(k => ({
      openTime: k[0],
      open: parseFloat(k[1]),
      close: parseFloat(k[4]),
    }));
  });
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
