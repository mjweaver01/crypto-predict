// Prediction track record: persist each directional "bet" we make for a window
// and, once the window closes, the realized outcome. Stored as a single JSON
// object (id -> entry) on disk so it survives restarts and can be backfilled.

import { env } from '../cache.ts';
import { fetchCandleAt } from '../sources/binance.ts';
import { fetchMarketOutcome, slugFor } from '../sources/polymarket.ts';
import type {
  LedgerEntry,
  LedgerSummary,
  Prediction,
  RangeId,
  Side,
} from '../../shared/types.ts';

const PATH = env('LEDGER_PATH', `${process.cwd()}/data/ledger.json`);
const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '1d'];

type Store = Record<string, LedgerEntry>;

// Serialize read-modify-write so concurrent predicts can't clobber the file.
let chain: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

async function load(): Promise<Store> {
  const file = Bun.file(PATH);
  if (!(await file.exists())) return {};
  try {
    return (await file.json()) as Store;
  } catch {
    return {};
  }
}

async function save(store: Store): Promise<void> {
  await Bun.write(PATH, JSON.stringify(store, null, 2));
}

/** Polymarket slug for a window (daily is keyed by its resolution noon). */
function slugForRange(id: RangeId, startMs: number, endMs: number): string {
  return id === '1d' ? slugFor['1d'](endMs) : slugFor[id](startMs);
}

/**
 * Persist the frozen committed call for each open window. The call is locked in
 * once (early, while the horizon is long) and written here exactly once — never
 * overwritten by later ticks — so the graded bet is a genuine forward-looking
 * wager rather than a peek at where price ended up. Windows without a committed
 * call (first observed too late to decide) are skipped entirely.
 */
export async function recordPredictions(p: Prediction): Promise<void> {
  await withLock(async () => {
    const store = await load();
    for (const r of p.ranges) {
      const c = r.committed;
      if (!c) continue; // no genuine forward-looking call → don't grade it
      const startMs = Date.parse(r.windowStart);
      const endMs = Date.parse(r.windowEnd);
      const id = `${r.id}:${startMs}`;
      const existing = store[id];
      if (existing) continue; // call already committed & recorded (or resolved)
      store[id] = {
        id,
        rangeId: r.id,
        slug: r.market?.slug ?? slugForRange(r.id, startMs, endMs),
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        strike: c.strike,
        probUp: c.probUp,
        rawProbUp: c.rawProbUp,
        side: c.side,
        confidence: c.confidence,
        marketImpliedUp: r.market?.impliedUp,
        features: c.features,
        horizonMinutes: c.horizonMinutes,
        decidedAt: c.decidedAt,
        source: 'live',
        outcome: null,
      };
    }
    await save(store);
  });
}

/** Resolve one matured entry; returns the patch or null if not resolvable yet. */
async function resolveOne(
  e: LedgerEntry
): Promise<Partial<LedgerEntry> | null> {
  // Prefer the real market resolution (Chainlink for 5m/15m, Binance for
  // 1h/daily) so the record reflects exactly what the market settled.
  if (e.slug) {
    const o = await fetchMarketOutcome(e.slug).catch(() => null);
    if (o) {
      const outcome: Side = o.outcomeUp ? 'UP' : 'DOWN';
      return {
        outcome,
        correct: outcome === e.side,
        resolvedBy: 'polymarket',
        resolvedAt: new Date().toISOString(),
      };
    }
  }
  // Fallback: Binance close of the window's final 1m candle vs the strike.
  const endMs = Date.parse(e.windowEnd);
  const c = await fetchCandleAt('1m', endMs - 60_000).catch(() => null);
  if (!c) return null;
  const outcome: Side = c.close >= e.strike ? 'UP' : 'DOWN';
  return {
    outcome,
    closePrice: c.close,
    correct: outcome === e.side,
    resolvedBy: 'binance',
    resolvedAt: new Date().toISOString(),
  };
}

/** Resolve all matured, unresolved entries. Returns how many were resolved. */
export async function resolvePending(): Promise<number> {
  const snapshot = await withLock(async () => load());
  const now = Date.now();
  const pending = Object.values(snapshot).filter(
    e => e.outcome == null && Date.parse(e.windowEnd) <= now
  );
  let resolved = 0;
  for (const e of pending) {
    const patch = await resolveOne(e);
    if (!patch) continue;
    await withLock(async () => {
      const store = await load();
      if (store[e.id]) store[e.id] = { ...store[e.id]!, ...patch };
      await save(store);
    });
    resolved++;
  }
  return resolved;
}

/** Insert/replace fully-formed (typically backfilled) entries. */
export async function addEntries(entries: LedgerEntry[]): Promise<void> {
  await withLock(async () => {
    const store = await load();
    for (const e of entries) store[e.id] = { ...store[e.id], ...e };
    await save(store);
  });
}

/** All entries, newest window first. */
export async function getLedger(): Promise<LedgerEntry[]> {
  const store = await load();
  return Object.values(store).sort(
    (a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart)
  );
}

const emptyRange = () => ({ resolved: 0, correct: 0, accuracy: 0 });

export function summarize(entries: LedgerEntry[]): LedgerSummary {
  const byRange = {
    '5m': emptyRange(),
    '15m': emptyRange(),
    '1h': emptyRange(),
    '1d': emptyRange(),
  } as LedgerSummary['byRange'];
  let resolved = 0;
  let correct = 0;
  let brierSum = 0;
  for (const e of entries) {
    if (e.outcome == null) continue;
    resolved++;
    const hit = e.correct ? 1 : 0;
    correct += hit;
    const y = e.outcome === 'UP' ? 1 : 0;
    brierSum += (e.probUp - y) ** 2;
    const r = byRange[e.rangeId];
    r.resolved++;
    r.correct += hit;
  }
  for (const id of RANGE_IDS) {
    const r = byRange[id];
    r.accuracy = r.resolved ? r.correct / r.resolved : 0;
  }
  return {
    total: entries.length,
    resolved,
    correct,
    accuracy: resolved ? correct / resolved : 0,
    brier: resolved ? brierSum / resolved : 0,
    byRange,
  };
}
