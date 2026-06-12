// Fill verification: cross-checks every live trade against the Polymarket
// data API to confirm fills, surface on-chain tx hashes, and flag discrepancies.
//
// The CLOB's postOrder response gives cost/shares at order time, but it's
// entirely off-chain. This module queries the data API's trade tape, filters
// to fills matching our wallet + orderId, and patches each TradeRecord with:
//   fillTxHashes  – on-chain tx hash(es) from the Polygon settlement
//   verifiedCostUsd / verifiedShares – what the tape actually shows
//   verifyStatus  – 'match' | 'mismatch' | 'notfound' | 'error'
//   verifyNote    – human-readable detail

import { env } from '../cache.ts';
import { getWallet } from './clob.ts';
import { getTrades, updateTrade } from './tradeLog.ts';
import type { TradeRecord } from '../../shared/types.ts';

const DATA = env('POLYMARKET_DATA_URL', 'https://data-api.polymarket.com');

/** Tolerance for cost/shares delta before flagging a mismatch (USD / shares). */
const TOLERANCE = 0.05;

interface DataApiFill {
  /** Matches the CLOB postOrder `orderID` (may be taker_order_id on the tape). */
  id?: string;
  taker_order_id?: string;
  maker_order_id?: string;
  transaction_hash?: string;
  transactionHash?: string;
  price?: string | number;
  size?: string | number;
  side?: string;
  outcome?: string;
  timestamp?: number;
  maker_address?: string;
  makerAddress?: string;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'bitcoin-predict/1.0' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`data-api ${res.status} ${url}`);
  return res.json();
}

/** Normalise a fill record's string/number fields to numbers. */
function normFill(f: DataApiFill): {
  price: number;
  size: number;
  txHash: string;
  orderId: string;
} {
  const price = Number(f.price);
  const size = Number(f.size);
  const txHash = (f.transaction_hash ?? f.transactionHash ?? '').trim();
  const orderId = (f.taker_order_id ?? f.maker_order_id ?? f.id ?? '').trim();
  return { price, size, txHash, orderId };
}

/**
 * Fetch all fills for a market from the data API, optionally filtered by wallet
 * address. Paginates up to MAX_PAGES to retrieve the full tape.
 */
async function fetchFills(
  conditionId: string,
  walletAddress: string
): Promise<DataApiFill[]> {
  const MAX_PAGES = 5;
  const out: DataApiFill[] = [];
  const base =
    `${DATA}/trades?market=${conditionId}` +
    `&maker_address=${walletAddress.toLowerCase()}&limit=500`;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = page === 0 ? base : `${base}&offset=${page * 500}`;
    let batch: DataApiFill[];
    try {
      batch = (await getJson(url)) as DataApiFill[];
    } catch {
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < 500) break;
  }
  return out;
}

/**
 * Verify all live (non-dry-run, filled/partial) trades and patch each record.
 * Returns the number of trades processed.
 */
export async function verifyTrades(): Promise<{
  processed: number;
  match: number;
  mismatch: number;
  notfound: number;
  error: number;
}> {
  const all = await getTrades();
  // Kalshi trades (instrument key `ticker|side`) have no on-chain tape to
  // verify against — the exchange's own fill report is already authoritative.
  const toVerify = all.filter(
    t =>
      t.status !== 'dry-run' &&
      (t.status === 'filled' || t.status === 'partial') &&
      !t.tokenId.includes('|')
  );

  const counts = { processed: 0, match: 0, mismatch: 0, notfound: 0, error: 0 };
  if (toVerify.length === 0) return counts;

  const wallet = getWallet();
  if (!wallet) throw new Error('POLYMARKET_PRIVATE_KEY not set');
  const walletAddress = wallet.address;

  // Group by conditionId to batch the API calls — one fetch per market covers
  // all of our fills in that condition.
  const byCondition = new Map<string, TradeRecord[]>();
  for (const t of toVerify) {
    const key = t.conditionId ?? `__no_condition__${t.id}`;
    const group = byCondition.get(key) ?? [];
    group.push(t);
    byCondition.set(key, group);
  }

  for (const [conditionId, group] of byCondition) {
    // Fetch fills once per condition, then distribute to each trade.
    let fills: DataApiFill[] = [];
    let fetchErr: string | undefined;
    if (conditionId.startsWith('__no_condition__')) {
      fetchErr = 'no conditionId on record';
    } else {
      try {
        fills = await fetchFills(conditionId, walletAddress);
      } catch (err) {
        fetchErr = String(err);
      }
    }

    for (const t of group) {
      const now = new Date().toISOString();
      let patch: Partial<TradeRecord>;

      if (fetchErr) {
        patch = {
          verifyStatus: 'error',
          verifyNote: fetchErr,
          verifiedAt: now,
        };
      } else {
        // Re-use the already-fetched fills — pass them as a pre-fetched set.
        patch = await verifyFromFills(t, fills, now);
      }

      await updateTrade(t.id, patch);
      counts.processed++;
      counts[patch.verifyStatus as keyof typeof counts]++;
      console.log(
        `[verify] ${t.id}: ${patch.verifyStatus} — ${patch.verifyNote}`
      );
    }
  }

  return counts;
}

/** Verify a single trade against an already-fetched fills array. */
function verifyFromFills(
  t: TradeRecord,
  fills: DataApiFill[],
  now: string
): Partial<TradeRecord> {
  const matched = t.orderId
    ? fills.filter(f => {
        const { orderId } = normFill(f);
        return orderId === t.orderId;
      })
    : fills.filter(f => {
        const placed = Date.parse(t.placedAt);
        const ft = (f.timestamp ?? 0) * 1000;
        return Math.abs(ft - placed) < 60_000;
      });

  if (matched.length === 0) {
    return {
      verifyStatus: 'notfound',
      verifyNote: t.orderId
        ? `orderId ${t.orderId} not in tape (${fills.length} fills for wallet)`
        : `no fills within 60 s of placedAt`,
      verifiedAt: now,
    };
  }

  let verifiedCostUsd = 0;
  let verifiedShares = 0;
  const txHashes: string[] = [];
  for (const f of matched) {
    const { price, size, txHash } = normFill(f);
    if (Number.isFinite(price) && Number.isFinite(size) && size > 0) {
      verifiedCostUsd += price * size;
      verifiedShares += size;
    }
    if (txHash && !txHashes.includes(txHash)) txHashes.push(txHash);
  }

  const costDelta = Math.abs((t.costUsd ?? 0) - verifiedCostUsd);
  const sharesDelta = Math.abs((t.shares ?? 0) - verifiedShares);
  const match = costDelta <= TOLERANCE && sharesDelta <= TOLERANCE;

  return {
    fillTxHashes: txHashes.length > 0 ? txHashes : undefined,
    verifiedCostUsd,
    verifiedShares,
    verifyStatus: match ? 'match' : 'mismatch',
    verifyNote:
      `${matched.length} fill${matched.length > 1 ? 's' : ''}` +
      (match
        ? ` · confirmed`
        : ` · Δcost $${costDelta.toFixed(3)} · Δshares ${sharesDelta.toFixed(3)}`),
    verifiedAt: now,
  };
}
