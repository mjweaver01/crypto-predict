// Live order execution: turns a freshly committed call whose EV verdict says
// BET into a real Polymarket CLOB order (or a faithful dry-run record).
//
// The decision logic deliberately mirrors the paper layer — same per-family
// min-edge gate, same fractional-Kelly sizing — but is re-checked against the
// EXECUTION-TIME book for the actual token being bought, not the commit-time
// snapshot: the book can move in the seconds between commit and execution, and
// an edge that evaporated must not be chased. Orders are marketable-limit FAK
// (fill what's there up to the cap, cancel the rest), so a fill can never be
// worse than the price the edge was re-validated at.
//
// Safety rails, all enforced here:
//   - one trade max per window, persisted across restarts (trades.json)
//   - only within the genuine commit span of the window (COMMIT_BY_FRACTION)
//   - per-trade USD cap, bankroll cap, minimum stake, market min order size
//   - max concurrently open positions
//   - daily realized-loss kill switch (resets at UTC midnight)
//   - slippage cap vs the frozen commit-time cost

import { OrderType, Side as ClobSide } from '@polymarket/clob-client';
import { env } from '../cache.ts';
import { bookTop, fetchMarketTokens } from '../sources/polymarket.ts';
import { getPolicy, kellyFraction } from '../model/paper.ts';
import { getClobClient, getUsdcBalance } from './clob.ts';
import { getTradeConfig } from './config.ts';
import {
  openTradeCount,
  realizedPnlTodayUsd,
  recordTrade,
  tradedWindowIds,
} from './tradeLog.ts';
import type {
  Prediction,
  RangePrediction,
  TradeRecord,
  TradeStatus,
} from '../../shared/types.ts';

/** Windows we already traded (or tried to) — never send a second order. */
let attempted: Set<string> | null = null;
/** Skip reasons already logged, so the 20s tick doesn't spam the console. */
const logged = new Set<string>();

async function ensureAttempted(): Promise<Set<string>> {
  if (!attempted) attempted = await tradedWindowIds();
  return attempted;
}

function skip(windowId: string, reason: string): void {
  const key = `${windowId}:${reason}`;
  if (logged.has(key)) return;
  logged.add(key);
  console.log(`[trade] skip ${windowId}: ${reason}`);
}

const roundDownToTick = (p: number, tick: number) =>
  Math.floor(p / tick + 1e-9) * tick;

/**
 * Evaluate one range and place at most one order for its window. Returns the
 * recorded trade, or null when nothing was (or could be) done.
 */
export async function maybeTrade(
  r: RangePrediction,
  now: number
): Promise<TradeRecord | null> {
  const cfg = getTradeConfig();
  if (!cfg.enabled) return null;
  if (!cfg.families.has(r.id)) return null;

  const c = r.committed;
  if (!c || r.paper?.action !== 'BET') return null;

  const startMs = Date.parse(r.windowStart);
  const windowId = `${r.id}:${startMs}`;
  const seen = await ensureAttempted();
  if (seen.has(windowId)) return null;

  // Only trade inside the same early span a genuine commitment requires; after
  // a restart an old commitment must not be executed mid-window.
  const commitBy = Math.max(
    0,
    Math.min(1, Number(env('COMMIT_BY_FRACTION', '0.2')) || 0.2)
  );
  const endMs = Date.parse(r.windowEnd);
  const elapsed = (now - startMs) / Math.max(1, endMs - startMs);
  if (elapsed > commitBy) {
    skip(windowId, 'past commit span');
    return null;
  }

  if (!r.market?.slug) {
    skip(windowId, 'no live market');
    return null;
  }

  // ── Account-level rails ───────────────────────────────────────────────
  if ((await openTradeCount()) >= cfg.maxOpenTrades) {
    skip(windowId, `max open positions (${cfg.maxOpenTrades})`);
    return null;
  }
  const pnlToday = await realizedPnlTodayUsd();
  if (pnlToday <= -cfg.dailyLossLimitUsd) {
    skip(
      windowId,
      `daily loss limit hit (${pnlToday.toFixed(2)} ≤ -${cfg.dailyLossLimitUsd})`
    );
    return null;
  }

  // ── Resolve the token being bought and its live book ─────────────────
  const tokens = await fetchMarketTokens(r.market.slug).catch(() => null);
  if (!tokens || tokens.tokenIds.length !== 2) {
    skip(windowId, 'market tokens unavailable');
    return null;
  }
  const outcomeIndex = c.side === 'UP' ? tokens.upIndex : 1 - tokens.upIndex;
  const tokenId = tokens.tokenIds[outcomeIndex]!;

  const top = await bookTop(tokenId).catch(() => undefined);
  const ask = top?.ask;
  if (ask === undefined || ask <= 0 || ask >= 1) {
    skip(windowId, 'no ask on side token');
    return null;
  }

  // ── Re-validate the edge at the execution-time price ─────────────────
  const policy = getPolicy();
  const pSide = c.side === 'UP' ? c.probUp : 1 - c.probUp;
  const edge = pSide - ask;
  if (edge < policy.minEdge[r.id]) {
    // The book may come back within the commit span — don't mark attempted.
    skip(
      windowId,
      `edge gone at execution (${edge.toFixed(3)} < ${policy.minEdge[r.id]})`
    );
    return null;
  }
  // Frozen commit-time cost of the side (what the paper verdict priced).
  const frozenCost = r.paper.cost ?? ask;
  if (ask > frozenCost + cfg.maxSlippage) {
    skip(
      windowId,
      `slippage cap (ask ${ask} > frozen ${frozenCost} + ${cfg.maxSlippage})`
    );
    return null;
  }

  // Marketable-limit cap: one tick through the ask to absorb book jitter, but
  // never above what keeps the minimum edge, and never above the slippage cap.
  const tick = tokens.tickSize && tokens.tickSize > 0 ? tokens.tickSize : 0.01;
  const limitPrice = roundDownToTick(
    Math.min(
      ask + tick,
      pSide - policy.minEdge[r.id],
      frozenCost + cfg.maxSlippage,
      1 - tick
    ),
    tick
  );
  if (limitPrice < ask) {
    skip(windowId, `limit ${limitPrice} below ask ${ask} after caps`);
    return null;
  }

  // ── Size the stake (fractional Kelly, same as the paper policy) ──────
  let balance: number;
  if (cfg.dryRun) {
    balance = cfg.bankrollCapUsd;
  } else {
    try {
      balance = await getUsdcBalance();
    } catch (err) {
      skip(windowId, `balance unavailable: ${err}`);
      return null;
    }
  }
  const bankroll = Math.min(balance, cfg.bankrollCapUsd);
  const stakeFraction = Math.min(
    policy.maxStakeFraction,
    policy.kellyFraction * kellyFraction(pSide, ask)
  );
  const stakeUsd = Math.min(stakeFraction * bankroll, cfg.maxStakeUsd, balance);
  if (stakeUsd < cfg.minStakeUsd) {
    skip(
      windowId,
      `stake $${stakeUsd.toFixed(2)} below min $${cfg.minStakeUsd}`
    );
    return null;
  }
  const minShares = tokens.minOrderSize ?? 0;
  if (stakeUsd / limitPrice < minShares) {
    skip(
      windowId,
      `stake $${stakeUsd.toFixed(2)} under market min size (${minShares} shares)`
    );
    return null;
  }

  // ── Place the order (or record the shadow fill) ──────────────────────
  // Mark attempted BEFORE posting: if the post's outcome is ever ambiguous
  // (timeout after send), the failure mode is a missed trade, not a double one.
  seen.add(windowId);

  const base: TradeRecord = {
    id: windowId,
    rangeId: r.id,
    slug: r.market.slug,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    side: c.side,
    tokenId,
    outcomeIndex,
    conditionId: tokens.conditionId,
    negRisk: tokens.negRisk,
    pSide,
    edge,
    quotedCost: ask,
    limitPrice,
    intendedUsd: stakeUsd,
    status: 'dry-run',
    placedAt: new Date(now).toISOString(),
  };

  if (cfg.dryRun) {
    const trade: TradeRecord = {
      ...base,
      costUsd: stakeUsd,
      shares: stakeUsd / ask,
      avgPrice: ask,
    };
    await recordTrade(trade);
    console.log(
      `[trade] DRY-RUN ${windowId} BUY ${c.side} $${stakeUsd.toFixed(2)} ` +
        `@ ${ask} (edge ${edge.toFixed(3)})`
    );
    return trade;
  }

  let status: TradeStatus = 'failed';
  let orderId: string | undefined;
  let costUsd: number | undefined;
  let shares: number | undefined;
  let error: string | undefined;
  try {
    const client = await getClobClient();
    const order = await client.createMarketOrder(
      {
        tokenID: tokenId,
        side: ClobSide.BUY,
        amount: stakeUsd,
        price: limitPrice,
        orderType: OrderType.FAK,
      },
      {
        tickSize: String(tick) as '0.1' | '0.01' | '0.001' | '0.0001',
        negRisk: tokens.negRisk,
      }
    );
    const res = (await client.postOrder(order, OrderType.FAK)) as {
      success?: boolean;
      errorMsg?: string;
      orderID?: string;
      status?: string;
      makingAmount?: string;
      takingAmount?: string;
    };
    orderId = res?.orderID;
    if (res?.success) {
      // For a BUY, makingAmount is the USD spent and takingAmount the shares.
      costUsd = Number(res.makingAmount) || 0;
      shares = Number(res.takingAmount) || 0;
      status =
        shares > 0
          ? costUsd >= stakeUsd * 0.99
            ? 'filled'
            : 'partial'
          : 'unfilled';
    } else {
      error = res?.errorMsg || 'order rejected';
    }
  } catch (err) {
    error = String(err);
  }

  const trade: TradeRecord = {
    ...base,
    status,
    orderId,
    costUsd,
    shares,
    avgPrice: shares && costUsd ? costUsd / shares : undefined,
    error,
  };
  await recordTrade(trade);
  if (status === 'filled' || status === 'partial') {
    console.log(
      `[trade] ${status.toUpperCase()} ${windowId} BUY ${c.side} ` +
        `$${costUsd!.toFixed(2)} → ${shares!.toFixed(2)} shares ` +
        `@ ${(costUsd! / shares!).toFixed(3)} (edge ${edge.toFixed(3)})`
    );
  } else {
    console.warn(`[trade] ${status} ${windowId}: ${error ?? 'no fill'}`);
  }
  return trade;
}

/**
 * Run the executor over every range of a fresh prediction. Errors are
 * contained per family so one bad market can't block the others.
 */
export async function executeTrades(p: Prediction, now: number): Promise<void> {
  if (!getTradeConfig().enabled) return;
  await Promise.all(
    p.ranges.map(r =>
      maybeTrade(r, now).catch(err =>
        console.warn(`[trade] ${r.id} execution failed:`, err)
      )
    )
  );
}
