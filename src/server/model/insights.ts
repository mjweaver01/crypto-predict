// Windowed log of the model's "read" over time. Every fresh prediction drops a
// compact snapshot (narrative + directional calls) into a ring
// buffer so the UI can scroll back through how sentiment evolved. The buffer is
// bounded by both age and count, and is persisted to disk (write-behind) so a
// restart doesn't erase the recent timeline.

import { readFileSync } from 'node:fs';
import { env } from '../cache.ts';
import type { CryptoId } from '../../shared/cryptos.ts';
import type { InsightSnapshot, Prediction, Side } from '../../shared/types.ts';

// How long to keep snapshots, and a hard cap so a tiny TTL can't grow it without
// bound. Defaults: ~3h of history, at most 600 entries.
const WINDOW_MS = Number(env('INSIGHTS_WINDOW_MIN', '180')) * 60_000;
const MAX_ENTRIES = Number(env('INSIGHTS_MAX', '600'));
const PATH = env('INSIGHTS_PATH', `${process.cwd()}/data/insights.json`);

/** Hydrate the buffer from the last persisted snapshot file, if present. */
function loadPersisted(): InsightSnapshot[] {
  try {
    const parsed = JSON.parse(readFileSync(PATH, 'utf8')) as unknown;
    return Array.isArray(parsed) ? (parsed as InsightSnapshot[]) : [];
  } catch {
    return []; // first run, or unreadable — start fresh
  }
}

const log: InsightSnapshot[] = loadPersisted();

// Write-behind persistence: serialized so writes never interleave, and
// fire-and-forget so recording a snapshot never blocks the predict path.
let writeChain: Promise<unknown> = Promise.resolve();
function persist(): void {
  const snapshot = JSON.stringify(log);
  writeChain = writeChain
    .then(() => Bun.write(PATH, snapshot))
    .catch(err => console.warn('[insights] persist failed:', err));
}

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

  // Dedupe against the last snapshot OF THE SAME CRYPTO — interleaved assets
  // must not mask each other's unchanged reads.
  const prev = [...log].reverse().find(s => (s.crypto ?? 'btc') === p.crypto);
  const sameSides =
    prev &&
    prev.narrative === p.narrative &&
    prev.calls.length === calls.length &&
    prev.calls.every((c, i) => c.side === calls[i]!.side);
  if (sameSides) return;

  log.push({
    crypto: p.crypto,
    asOf: p.asOf,
    price: p.stats.price,
    change24hPct: p.stats.change24hPct,
    narrative: p.narrative,
    calls,
  });
  prune(Date.parse(p.asOf) || Date.now());
  persist();
}

/** Retained snapshots, newest first, optionally for one crypto. */
export function getInsights(crypto?: CryptoId): InsightSnapshot[] {
  prune(Date.now());
  const all = [...log].reverse();
  return crypto ? all.filter(s => (s.crypto ?? 'btc') === crypto) : all;
}
