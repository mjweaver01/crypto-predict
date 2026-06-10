/**
 * Backfill TRADABLE prices for ledger rows that predate live order-book
 * capture, from Polymarket's historical trade tape (data-api /trades).
 *
 * The CLOB book itself has no history, but executed fills do: a taker BUY on
 * the Up token at p proves Up was buyable at p; a taker SELL proves it was
 * sellable. Fills on the Down token map through 1 − p. For each entry we use
 * only fills inside the window's genuine commit span (the first
 * COMMIT_BY_FRACTION of its life — the same rule the live wager obeys) and
 * take the WORST executable price per side, so the backfilled cost never
 * flatters the edge. Entries with no early fills are left untouched — the 5m
 * and 15m tapes are usually silent that early, which is exactly why live
 * capture remains the primary source. Patched rows are marked
 * `bookSource: 'trades'` so every scoreboard can distinguish them.
 *
 * Usage:  bun run backfill:book [-- --limit 200 --dry]
 */
import type { LedgerEntry, Side } from '../src/shared/types.ts';

const GAMMA =
  process.env.POLYMARKET_GAMMA_URL ?? 'https://gamma-api.polymarket.com';
const DATA =
  process.env.POLYMARKET_DATA_URL ?? 'https://data-api.polymarket.com';
const PATH = process.env.LEDGER_PATH ?? `${process.cwd()}/data/ledger.json`;
const COMMIT_BY_FRACTION =
  Number(process.env.COMMIT_BY_FRACTION ?? '0.2') || 0.2;

const DRY = process.argv.includes('--dry');
const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
/** Max entries to patch per run (newest first), to stay polite to the API. */
const LIMIT = argNum('limit', 200);
/** Hard cap on trade-tape pagination per market. */
const MAX_PAGES = 20;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bitcoin-predict/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

interface Trade {
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  outcome: string;
  timestamp: number; // unix seconds
}

/** All fills for a market inside [fromSec, toSec], walking the tape backwards. */
async function fillsInSpan(
  conditionId: string,
  fromSec: number,
  toSec: number
): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let batch: Trade[];
    try {
      batch = (await getJson(
        `${DATA}/trades?market=${conditionId}&limit=1000&offset=${page * 1000}`
      )) as Trade[];
    } catch {
      // The data-api caps how deep the tape can be paged (~4000); a very busy
      // market whose open lies past the cap just yields whatever we reached.
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    let oldest = Infinity;
    for (const t of batch) {
      oldest = Math.min(oldest, t.timestamp);
      if (t.timestamp >= fromSec && t.timestamp <= toSec) out.push(t);
    }
    if (oldest < fromSec) break; // tape is newest-first; we've walked past the span
    await sleep(100);
  }
  return out;
}

/**
 * Worst executable Up-token bid/ask proven by the fills. BUY fills show where
 * that side was buyable (ask); SELL fills where it was sellable (bid); Down
 * fills mirror through 1 − p. Dust fills (< 1 share) are ignored.
 */
function bookFromFills(
  fills: Trade[]
): { bidUp?: number; askUp?: number; lastFillSec?: number } | undefined {
  const askC: number[] = [];
  const bidC: number[] = [];
  let lastFillSec = 0;
  for (const t of fills) {
    const p = Number(t.price);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || Number(t.size) < 1) continue;
    const isUp = t.outcome.toLowerCase() === 'up';
    const buys = t.side === 'BUY';
    if (isUp) (buys ? askC : bidC).push(p);
    else (buys ? bidC : askC).push(1 - p);
    lastFillSec = Math.max(lastFillSec, t.timestamp);
  }
  if (!askC.length && !bidC.length) return undefined;
  const askUp = askC.length ? Math.max(...askC) : undefined; // worst buy
  const bidUp = bidC.length ? Math.min(...bidC) : undefined; // worst sell
  // A "crossed" reconstruction means price moved materially inside the span —
  // too ambiguous to price a single commit instant from.
  if (askUp !== undefined && bidUp !== undefined && bidUp > askUp)
    return undefined;
  return { bidUp, askUp, lastFillSec };
}

/** The side of the book this entry's bet would actually need. */
function neededSideCovered(
  side: Side,
  b: { bidUp?: number; askUp?: number }
): boolean {
  return side === 'UP' ? b.askUp !== undefined : b.bidUp !== undefined;
}

const store = (await Bun.file(PATH).json()) as Record<string, LedgerEntry>;
const candidates = Object.values(store)
  .filter(
    e =>
      e.outcome != null &&
      e.slug &&
      e.marketBidUp === undefined &&
      e.marketAskUp === undefined
  )
  .sort((a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart))
  .slice(0, LIMIT);

console.log(
  `${candidates.length} resolved entries lack tradable prices (scanning newest first, limit ${LIMIT})${DRY ? ' [dry run]' : ''}`
);

let patched = 0;
let noMarket = 0;
let noFills = 0;
const byFam: Record<string, number> = {};

for (const e of candidates) {
  let conditionId: string | undefined;
  try {
    const m = (await getJson(`${GAMMA}/markets/slug/${e.slug}`)) as {
      conditionId?: string;
    };
    conditionId = m?.conditionId;
  } catch {
    /* market gone */
  }
  if (!conditionId) {
    noMarket++;
    continue;
  }

  const startMs = Date.parse(e.windowStart);
  const endMs = Date.parse(e.windowEnd);
  const commitEndMs = startMs + (endMs - startMs) * COMMIT_BY_FRACTION;
  let book: ReturnType<typeof bookFromFills>;
  try {
    const fills = await fillsInSpan(
      conditionId,
      startMs / 1000,
      commitEndMs / 1000
    );
    book = bookFromFills(fills);
  } catch (err) {
    console.warn(`  ${e.id}: trade fetch failed (${err})`);
    continue;
  }
  if (!book || !neededSideCovered(e.side, book)) {
    noFills++;
    continue;
  }

  patched++;
  byFam[e.rangeId] = (byFam[e.rangeId] ?? 0) + 1;
  if (!DRY) {
    const cur = store[e.id]!;
    cur.marketBidUp = book.bidUp;
    cur.marketAskUp = book.askUp;
    cur.marketQuotedAt = new Date(book.lastFillSec! * 1000).toISOString();
    cur.bookSource = 'trades';
  }
  await sleep(120);
}

if (!DRY && patched > 0) {
  // Re-read and re-apply just before saving so a concurrently running server's
  // fresh commits between our load and save are not clobbered.
  const fresh = (await Bun.file(PATH).json()) as Record<string, LedgerEntry>;
  for (const [id, e] of Object.entries(store)) {
    if (e.bookSource === 'trades' && fresh[id]) {
      fresh[id].marketBidUp = e.marketBidUp;
      fresh[id].marketAskUp = e.marketAskUp;
      fresh[id].marketQuotedAt = e.marketQuotedAt;
      fresh[id].bookSource = 'trades';
    }
  }
  await Bun.write(PATH, JSON.stringify(fresh, null, 2));
}

console.log(
  `\npatched ${patched} entries with fill-derived tradable prices ` +
    `(${
      Object.entries(byFam)
        .map(([k, v]) => `${k}: ${v}`)
        .join(', ') || 'none'
    })`
);
console.log(
  `skipped: ${noFills} with no usable early-window fills, ${noMarket} with no market metadata`
);
if (DRY) console.log('dry run — nothing written');
