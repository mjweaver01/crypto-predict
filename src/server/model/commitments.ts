// Per-window committed calls. The model recomputes a fresh "live" probability
// every tick, which legitimately swings toward 0/1 as a window approaches
// expiry (it's the delta of a binary option). That live read is great for a
// "where it stands now" gauge but makes a poor track record: grading the last
// pre-close snapshot peeks at where price ended up.
//
// Instead we COMMIT a single directional call per window, early (while the
// horizon is still long), then freeze it until the window resolves. That frozen
// call is the bet we actually grade — a genuine, forward-looking wager.
//
// The map is the authoritative in-memory store for this process and is hydrated
// from the on-disk ledger on first use so commitments survive restarts.

import { env } from '../cache.ts';
import { getLedger } from './ledger.ts';
import type {
  CommittedCall,
  RangePrediction,
  Side,
} from '../../shared/types.ts';

/**
 * Commit a window's call only if it is first observed within this fraction of
 * the window elapsed. 0.2 ⇒ within the first 20% (≥4 min left on a 5m window),
 * which in practice locks in at the first tick after the window opens. Windows
 * first seen later than this get no commitment (no real wager was possible).
 */
const COMMIT_BY_FRACTION = Math.max(
  0,
  Math.min(1, Number(env('COMMIT_BY_FRACTION', '0.2')) || 0.2)
);

/** Stable id: `${crypto}:${rangeId}:${windowStartMs}` (matches the ledger key). */
function windowId(
  r: Pick<RangePrediction, 'crypto' | 'id' | 'windowStart'>
): string {
  return `${r.crypto}:${r.id}:${Date.parse(r.windowStart)}`;
}

const commitments = new Map<string, CommittedCall>();

let hydrated = false;

/**
 * Load still-open committed calls from the ledger into memory once, so a
 * restart mid-window doesn't re-commit a fresh (later, less forward-looking)
 * call for a window we already decided on.
 */
export async function ensureHydrated(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const entries = await getLedger();
    for (const e of entries) {
      if (e.outcome != null) continue; // resolved → window is over
      // Legacy rows carry no crypto field — they are all btc.
      const id = `${e.crypto ?? 'btc'}:${e.rangeId}:${Date.parse(e.windowStart)}`;
      if (commitments.has(id)) continue;
      commitments.set(id, {
        probUp: e.probUp,
        rawProbUp: e.rawProbUp ?? e.probUp,
        side: e.side,
        confidence: e.confidence,
        strike: e.strike,
        features: e.features,
        decidedAt: e.decidedAt,
        horizonMinutes: e.horizonMinutes,
        marketBidUp: e.marketBidUp,
        marketAskUp: e.marketAskUp,
        marketUpBids: e.marketUpBids,
        marketUpAsks: e.marketUpAsks,
      });
    }
  } catch (err) {
    console.warn('[commitments] hydrate failed:', err);
  }
}

/** Read-only lookup of an existing commitment for a window id. */
export function getCommitment(id: string): CommittedCall | undefined {
  return commitments.get(id);
}

/**
 * Return the frozen call for this window, committing one from the current live
 * read if the window is still fresh enough and none exists yet. Returns
 * undefined when the window was first observed too late to make a genuine call.
 */
export function decide(
  r: RangePrediction,
  now: number
): CommittedCall | undefined {
  const id = windowId(r);
  const existing = commitments.get(id);
  if (existing) return existing;

  const startMs = Date.parse(r.windowStart);
  const endMs = Date.parse(r.windowEnd);
  const length = endMs - startMs;
  if (length <= 0 || now < startMs || now >= endMs) return undefined;

  const elapsedFraction = (now - startMs) / length;
  if (elapsedFraction > COMMIT_BY_FRACTION) return undefined; // seen too late

  const side: Side = r.probUp >= 0.5 ? 'UP' : 'DOWN';
  const call: CommittedCall = {
    probUp: r.probUp,
    rawProbUp: r.rawProbUp,
    side,
    confidence: Math.max(r.probUp, 1 - r.probUp),
    strike: r.strike,
    features: r.features,
    decidedAt: new Date(now).toISOString(),
    horizonMinutes: r.horizonMinutes,
    // Freeze the tradable book with the call: the paper bet must be priced at
    // what was executable when the wager was made, not a later (wiser) quote.
    // Depth included, so fills can be sized against real visible liquidity.
    marketBidUp: r.market?.upBestBid,
    marketAskUp: r.market?.upBestAsk,
    marketUpBids: r.market?.upBids,
    marketUpAsks: r.market?.upAsks,
  };
  commitments.set(id, call);
  return call;
}
