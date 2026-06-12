// Persistent record of real (and dry-run) trades: data/trades.json. Unlike the
// paper scoreboard — a deterministic replay recomputed from the ledger — this
// is a log of EXECUTION: orders actually sent, the fills they got, and the
// realized P&L. It is also the executor's idempotency store (one trade max per
// window, surviving restarts) and the source for the daily-loss kill switch.

import { env } from '../cache.ts';
import { getLedger } from '../model/ledger.ts';
import type { TradeRecord } from '../../shared/types.ts';

const PATH = env('TRADES_PATH', `${process.cwd()}/data/trades.json`);

type Store = Record<string, TradeRecord>;

// Serialize read-modify-write so concurrent updates can't clobber the file
// (same pattern as the ledger).
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

/** Record a new trade (insert or full replace by window id). */
export async function recordTrade(t: TradeRecord): Promise<void> {
  await withLock(async () => {
    const store = await load();
    store[t.id] = t;
    await save(store);
  });
}

/** Patch an existing trade (no-op when the id is unknown). */
export async function updateTrade(
  id: string,
  patch: Partial<TradeRecord>
): Promise<void> {
  await withLock(async () => {
    const store = await load();
    if (store[id]) {
      store[id] = { ...store[id]!, ...patch };
      await save(store);
    }
  });
}

/** All trades, newest window first. */
export async function getTrades(): Promise<TradeRecord[]> {
  const store = await withLock(async () => load());
  return Object.values(store).sort(
    (a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart)
  );
}

/** Window ids that already have a trade record (executor idempotency). */
export async function tradedWindowIds(): Promise<Set<string>> {
  const store = await withLock(async () => load());
  return new Set(Object.keys(store));
}

/** A trade that put (or simulated) money in the market and hasn't settled. */
export function isOpen(t: TradeRecord): boolean {
  const holds =
    t.status === 'filled' || t.status === 'partial' || t.status === 'dry-run';
  return holds && (t.shares ?? 0) > 0 && t.settledAt === undefined;
}

/** Count of open positions (concurrency rail). */
export async function openTradeCount(): Promise<number> {
  return (await getTrades()).filter(isOpen).length;
}

/** Realized P&L (USD) across trades settled during the current UTC day. */
export async function realizedPnlTodayUsd(): Promise<number> {
  const dayStart = new Date().setUTCHours(0, 0, 0, 0);
  let pnl = 0;
  for (const t of await getTrades()) {
    if (t.settledAt && Date.parse(t.settledAt) >= dayStart) {
      pnl += t.pnlUsd ?? 0;
    }
  }
  return pnl;
}

/**
 * Settle open trades whose windows have resolved, using the same outcome the
 * ledger recorded (Polymarket resolution, Binance fallback). A winning share
 * redeems for $1, so P&L = shares − cost on a win and −cost on a loss.
 * Returns how many trades were settled.
 */
export async function settleTrades(): Promise<number> {
  const trades = (await getTrades()).filter(isOpen);
  if (trades.length === 0) return 0;
  const outcomes = new Map(
    (await getLedger())
      .filter(e => e.outcome != null)
      .map(e => [e.id, e.outcome!])
  );
  let settled = 0;
  for (const t of trades) {
    const outcome = outcomes.get(t.id);
    if (!outcome) continue;
    const won = outcome === t.side;
    const cost = t.costUsd ?? 0;
    const pnlUsd = won ? (t.shares ?? 0) - cost : -cost;
    await updateTrade(t.id, {
      outcome,
      won,
      pnlUsd,
      settledAt: new Date().toISOString(),
    });
    console.log(
      `[trade] settled ${t.id} ${t.side} → ${outcome} ` +
        `(${won ? 'WON' : 'LOST'} ${pnlUsd >= 0 ? '+' : ''}$${pnlUsd.toFixed(2)})`
    );
    settled++;
  }
  return settled;
}
