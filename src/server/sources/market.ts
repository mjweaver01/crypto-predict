// Platform facade: one import point for "the prediction market we run
// against", selected by TRADING_PLATFORM (polymarket | kalshi, default
// polymarket). Everything window-shaped upstream (predict route, ledger,
// executor) talks to this module; only the implementations below know whether
// a market id is a Polymarket slug or a Kalshi ticker.
//
// Outcome resolution is routed by the ID'S OWN SHAPE, not the active platform:
// ledger rows recorded under one platform must still resolve correctly after
// the env var is switched.

import { env } from '../cache.ts';
import * as pm from './polymarket.ts';
import * as kalshi from './kalshi.ts';
import type { CryptoId } from '../../shared/cryptos.ts';
import type { MarketQuote, RangeId } from '../../shared/types.ts';

export type PlatformId = 'polymarket' | 'kalshi';

/** The configured trading/market platform (default polymarket). */
export function getPlatform(): PlatformId {
  return env('TRADING_PLATFORM', 'polymarket').toLowerCase() === 'kalshi'
    ? 'kalshi'
    : 'polymarket';
}

/** Display name of the active platform. */
export function platformLabel(): string {
  return getPlatform() === 'kalshi' ? 'Kalshi' : 'Polymarket';
}

/**
 * Deterministic market id (Polymarket slug / Kalshi ticker) for a crypto +
 * family + window, or null when the active platform has no such market —
 * Kalshi only runs the 15m up/down family.
 */
export function marketIdFor(
  crypto: CryptoId,
  rangeId: RangeId,
  windowStartMs: number,
  windowEndMs: number
): string | null {
  if (getPlatform() === 'kalshi') {
    return kalshi.marketTicker(crypto, rangeId, windowEndMs);
  }
  // Polymarket's daily market is keyed by its RESOLUTION day (window end).
  return pm.marketSlug(
    crypto,
    rangeId,
    rangeId === '1d' ? windowEndMs : windowStartMs
  );
}

/** Live quote for a market id, routed by the id's shape. */
export async function fetchMarketQuote(
  id: string,
  windowStartMs: number,
  windowEndMs: number
): Promise<MarketQuote | null> {
  return kalshi.isKalshiTicker(id)
    ? kalshi.fetchMarket(id, windowStartMs, windowEndMs)
    : pm.fetchMarket(id, windowStartMs, windowEndMs);
}

/**
 * The platform's EXACT settlement "price to beat" for a window, when it
 * exposes one (Polymarket: the Chainlink-resolved 5m/15m/4h families; Kalshi:
 * the 15m family's floor_strike). Undefined otherwise — callers fall back to
 * their Binance boundary-candle proxy.
 */
export async function fetchPlatformStrike(
  rangeId: RangeId,
  windowStartMs: number,
  windowEndMs: number,
  crypto: CryptoId
): Promise<number | undefined> {
  return getPlatform() === 'kalshi'
    ? kalshi.fetchKalshiStrike(rangeId, windowEndMs, crypto)
    : pm.fetchPolymarketStrike(rangeId, windowStartMs, windowEndMs, crypto);
}

/**
 * Realized outcome of a market id (1 = Up, 0 = Down), or null while
 * unresolved. Routed by id shape so historical rows from either platform
 * resolve regardless of which platform is active now.
 */
export async function fetchOutcome(
  id: string
): Promise<{ outcomeUp: number; platform: PlatformId } | null> {
  if (kalshi.isKalshiTicker(id)) {
    const o = await kalshi.fetchMarketOutcome(id);
    return o ? { ...o, platform: 'kalshi' } : null;
  }
  const o = await pm.fetchMarketOutcome(id);
  return o ? { outcomeUp: o.outcomeUp, platform: 'polymarket' } : null;
}

/**
 * What the active platform's market for a family settles against, for display
 * and strike-proxy bookkeeping. 'binance' families carry our own exact strike;
 * the others expose a platform strike that may be momentarily unavailable.
 */
export function resolutionSourceFor(
  rangeId: RangeId
): 'chainlink' | 'binance' | 'cfbenchmarks' {
  if (getPlatform() === 'kalshi') {
    return rangeId === '15m' ? 'cfbenchmarks' : 'binance';
  }
  return rangeId === '1h' || rangeId === '1d' ? 'binance' : 'chainlink';
}
