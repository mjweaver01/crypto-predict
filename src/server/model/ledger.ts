// Prediction track record: persist each directional "bet" we make for a window
// and, once the window closes, the realized outcome. Stored as a single JSON
// object (id -> entry) on disk so it survives restarts and can be backfilled.

import { env } from '../cache.ts';
import { fetchCandleAt } from '../sources/binance.ts';
import { fetchOutcome, marketIdFor } from '../sources/market.ts';
import { CRYPTOS, type CryptoId } from '../../shared/cryptos.ts';
import type {
  LedgerEntry,
  LedgerSummary,
  Prediction,
  RangeId,
  Side,
} from '../../shared/types.ts';

const PATH = env('LEDGER_PATH', `${process.cwd()}/data/ledger.json`);
const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

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

// In-memory mirror of the on-disk store. While the server runs, this process is
// the only writer, so after the first read we serve from memory instead of
// re-parsing the multi-MB ledger on every call. Re-parsing it dozens of times a
// second (once per crypto per commit tick, plus per request) is synchronous work
// that pegged the single JS thread and made page loads time out. Offline scripts
// (backfill) run as separate processes and load their own copy, so they're
// unaffected; their writes are only picked up on the next server restart.
let memo: Store | null = null;

/**
 * Drop the in-memory mirror so the next read re-parses from disk. Only the
 * analytics worker calls this: it runs in a SEPARATE process with its own
 * module state, so resetting its copy lets it pick up commits the main process
 * has since flushed without ever touching the main thread's authoritative
 * `memo` (which still holds not-yet-flushed live commits).
 */
export function reloadLedger(): void {
  memo = null;
}

async function load(): Promise<Store> {
  if (memo) return memo;
  const file = Bun.file(PATH);
  if (!(await file.exists())) {
    memo = {};
    return memo;
  }
  try {
    memo = (await file.json()) as Store;
  } catch {
    memo = {};
  }
  return memo;
}

// Write-behind persistence. `memo` is authoritative while the server runs, so
// callers update it synchronously and we COALESCE the actual disk write.
// Re-serializing the multi-MB ledger is the single most expensive synchronous
// operation on the request thread: at a window boundary every tracked crypto
// commits a fresh call within the same tick, which previously fired one full
// JSON.stringify + write PER crypto, back-to-back, freezing the event loop long
// enough that a page refresh mid-boundary timed out. Debouncing collapses that
// burst into a single write a moment after the boundary, off the hot path.
const SAVE_DEBOUNCE_MS = Number(env('LEDGER_SAVE_DEBOUNCE_MS', '300')) || 300;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// Serialize writes so two flushes can never interleave on disk.
let writeChain: Promise<void> = Promise.resolve();

/** Persist the current `memo` to disk now (serialized against other writes). */
function writeNow(): Promise<void> {
  writeChain = writeChain.then(async () => {
    if (!memo) return;
    try {
      await Bun.write(PATH, JSON.stringify(memo, null, 2));
    } catch (err) {
      console.warn('[ledger] persist failed:', err);
    }
  });
  return writeChain;
}

/**
 * Update the in-memory store immediately and schedule a coalesced disk flush.
 * Synchronous on purpose: the lock-protected read-modify-write no longer waits
 * on disk I/O, and rapid successive saves collapse into one write.
 */
function save(store: Store): void {
  memo = store;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void writeNow();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Force any pending write to complete. Long-running offline scripts (backfill)
 * must call this before exiting so a debounced write isn't lost on process end.
 */
export async function flushLedger(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await writeNow();
}

/** Market id for a window on the active platform, when it offers one. */
function slugForRange(
  crypto: CryptoId,
  id: RangeId,
  startMs: number,
  endMs: number
): string | undefined {
  return marketIdFor(crypto, id, startMs, endMs) ?? undefined;
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
    // Most ticks add nothing: a window's call is committed once and frozen, so
    // every later tick within that window hits the `existing` guard below. Only
    // serialize + write the (multi-MB) file when something genuinely changed,
    // instead of re-stringifying the whole ledger on every single tick.
    let dirty = false;
    for (const r of p.ranges) {
      const c = r.committed;
      if (!c) continue; // no genuine forward-looking call → don't grade it
      const startMs = Date.parse(r.windowStart);
      const endMs = Date.parse(r.windowEnd);
      const id = `${r.crypto}:${r.id}:${startMs}`;
      // A btc window recorded under the legacy id (pre multi-crypto) must not
      // be double-recorded under the new id — that would grade it twice.
      const legacyId = `${r.id}:${startMs}`;
      const existing =
        store[id] ?? (r.crypto === 'btc' ? store[legacyId] : undefined);
      if (existing) continue; // call already committed & recorded (or resolved)
      store[id] = {
        id,
        crypto: r.crypto,
        rangeId: r.id,
        slug: r.market?.slug ?? slugForRange(r.crypto, r.id, startMs, endMs),
        windowStart: r.windowStart,
        windowEnd: r.windowEnd,
        strike: c.strike,
        probUp: c.probUp,
        rawProbUp: c.rawProbUp,
        side: c.side,
        confidence: c.confidence,
        marketImpliedUp: r.market?.impliedUp,
        // Prefer the book frozen with the call: after a restart this tick's
        // live quote is later than the commit instant the call came from.
        marketBidUp: c.marketBidUp ?? r.market?.upBestBid,
        marketAskUp: c.marketAskUp ?? r.market?.upBestAsk,
        marketUpBids: c.marketUpBids ?? r.market?.upBids,
        marketUpAsks: c.marketUpAsks ?? r.market?.upAsks,
        marketQuotedAt: r.market?.quotedAt,
        bookSource:
          (c.marketBidUp ?? r.market?.upBestBid) !== undefined ||
          (c.marketAskUp ?? r.market?.upBestAsk) !== undefined
            ? 'live'
            : undefined,
        features: c.features,
        horizonMinutes: c.horizonMinutes,
        decidedAt: c.decidedAt,
        source: 'live',
        outcome: null,
      };
      dirty = true;
    }
    if (dirty) save(store);
  });
}

/** Resolve one matured entry; returns the patch or null if not resolvable yet. */
async function resolveOne(
  e: LedgerEntry
): Promise<Partial<LedgerEntry> | null> {
  // Prefer the real market resolution so the record reflects exactly what the
  // market settled. Routed by the slug's own shape, so rows recorded under
  // either platform keep resolving after a TRADING_PLATFORM switch.
  if (e.slug) {
    const o = await fetchOutcome(e.slug).catch(() => null);
    if (o) {
      const outcome: Side = o.outcomeUp ? 'UP' : 'DOWN';
      return {
        outcome,
        correct: outcome === e.side,
        resolvedBy: o.platform,
        resolvedAt: new Date().toISOString(),
      };
    }
  }
  // Fallback: Binance close of the window's final 1m candle vs the strike.
  const endMs = Date.parse(e.windowEnd);
  const symbol = CRYPTOS[e.crypto ?? 'btc'].binanceSymbol;
  const c = await fetchCandleAt('1m', endMs - 60_000, symbol).catch(() => null);
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
      save(store);
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
    save(store);
    // Scripts run as one-shot processes and exit right after; force the write
    // so the debounced flush isn't lost on process end.
    await flushLedger();
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
    '4h': emptyRange(),
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
