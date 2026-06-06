// Windowed in-memory log of the model's "read" over time. Every fresh prediction
// drops a compact snapshot (narrative + reasoning + directional calls) into a
// ring buffer so the UI can scroll back through how sentiment evolved. Nothing is
// persisted: the buffer is bounded by both age and count and resets on restart.

import { env } from '../cache.ts';
import type {
  InsightSnapshot,
  Prediction,
  Side,
} from '../../shared/types.ts';

// How long to keep snapshots, and a hard cap so a tiny TTL can't grow it without
// bound. Defaults: ~3h of history, at most 600 entries.
const WINDOW_MS = Number(env('INSIGHTS_WINDOW_MIN', '180')) * 60_000;
const MAX_ENTRIES = Number(env('INSIGHTS_MAX', '600'));

const log: InsightSnapshot[] = [];

/** Drop entries older than the window or beyond the count cap (oldest first). */
function prune(now: number): void {
  const cutoff = now - WINDOW_MS;
  while (log.length && Date.parse(log[0]!.asOf) < cutoff) log.shift();
  while (log.length > MAX_ENTRIES) log.shift();
}

/**
 * Record one snapshot of the current model read. Called only when a fresh
 * prediction is computed (not on cache hits). Consecutive duplicates — same
 * narrative and identical per-range sides — are skipped so the timeline reflects
 * genuine changes rather than every refresh tick.
 */
export function recordInsight(p: Prediction): void {
  const calls = p.ranges.map(r => ({
    id: r.id,
    label: r.label,
    probUp: r.probUp,
    side: (r.probUp >= 0.5 ? 'UP' : 'DOWN') as Side,
  }));

  const prev = log[log.length - 1];
  const sameSides =
    prev &&
    prev.narrative === p.narrative &&
    prev.calls.length === calls.length &&
    prev.calls.every((c, i) => c.side === calls[i]!.side);
  if (sameSides) return;

  log.push({
    asOf: p.asOf,
    price: p.stats.price,
    change24hPct: p.stats.change24hPct,
    narrative: p.narrative,
    reasoning: p.reasoning,
    llmApplied: p.llmApplied,
    calls,
  });
  prune(Date.parse(p.asOf) || Date.now());
}

/** All retained snapshots, newest first. */
export function getInsights(): InsightSnapshot[] {
  prune(Date.now());
  return [...log].reverse();
}
