// Live order execution: turns a freshly committed call whose EV verdict says
// BET into a real order on the configured platform (Polymarket CLOB or
// Kalshi), or a faithful dry-run record. All venue mechanics live behind the
// Venue interface in venue.ts; this module owns the decision.
//
// The decision logic deliberately mirrors the paper layer — same per-family
// min-edge gate, same fractional-Kelly sizing — but is re-checked against the
// EXECUTION-TIME book for the actual instrument being bought, not the
// commit-time snapshot: the book can move in the seconds between commit and
// execution, and an edge that evaporated must not be chased. Orders are
// marketable-limit IOC (fill what's there up to the cap, cancel the rest), so
// a fill can never be worse than the price the edge was re-validated at.
//
// Safety rails, all enforced here:
//   - one trade max per window, persisted across restarts (trades.json)
//   - only within the genuine commit span of the window (COMMIT_BY_FRACTION)
//   - per-trade USD cap, bankroll cap, minimum stake, market min order size
//   - max concurrently open positions
//   - daily realized-loss kill switch (resets at UTC midnight)
//   - slippage cap vs the frozen commit-time cost

import { env } from '../cache.ts';
import {
  feeAdjustedCost,
  fillSide,
  getPolicy,
  kellyFraction,
} from '../model/paper.ts';
import { getVenue } from './venue.ts';
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
  if (!cfg.cryptos.has(r.crypto)) return null;

  const c = r.committed;
  if (!c || r.paper?.action !== 'BET') return null;

  const startMs = Date.parse(r.windowStart);
  const windowId = `${r.crypto}:${r.id}:${startMs}`;
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

  // ── Resolve the instrument being bought and its live book ────────────
  const venue = getVenue();
  const inst = await venue
    .resolveInstrument(r.market.slug, c.side)
    .catch(() => null);
  if (!inst) {
    skip(windowId, 'market instrument unavailable');
    return null;
  }

  const [top, feeBps] = await Promise.all([
    venue.fetchBook(inst).catch(() => undefined),
    venue.fetchFeeBps(inst),
  ]);
  const ask = top?.ask;
  if (ask === undefined || ask <= 0 || ask >= 1) {
    skip(windowId, 'no ask on side instrument');
    return null;
  }

  // ── Re-validate the edge at the execution-time, FEE-ADJUSTED price ────
  const policy = getPolicy();
  const pSide = c.side === 'UP' ? c.probUp : 1 - c.probUp;
  const effAsk = feeAdjustedCost(ask, feeBps, policy.feeModel);
  const edge = pSide - effAsk;
  if (edge < policy.minEdge[r.id]) {
    // The book may come back within the commit span — don't mark attempted.
    skip(
      windowId,
      `edge gone at execution (${edge.toFixed(3)} < ${policy.minEdge[r.id]} after ${feeBps}bps fee)`
    );
    return null;
  }
  // Frozen commit-time cost of the side (what the paper verdict priced —
  // already fee-adjusted by decideBet, so compare in effective terms).
  const frozenCost = r.paper.cost ?? effAsk;
  if (effAsk > frozenCost + cfg.maxSlippage) {
    skip(
      windowId,
      `slippage cap (eff ask ${effAsk.toFixed(3)} > frozen ${frozenCost.toFixed(3)} + ${cfg.maxSlippage})`
    );
    return null;
  }

  // Marketable-limit cap: one tick through the ask to absorb book jitter, but
  // never above what keeps the minimum edge AFTER fees, and never above the
  // slippage cap. The book quotes raw prices, so walk the raw limit down by
  // ticks until its fee-adjusted cost clears both effective ceilings.
  const tick = inst.tickSize;
  const effCeiling = Math.min(
    pSide - policy.minEdge[r.id],
    frozenCost + cfg.maxSlippage
  );
  let limitPrice = roundDownToTick(Math.min(ask + tick, 1 - tick), tick);
  while (
    limitPrice >= ask &&
    feeAdjustedCost(limitPrice, feeBps, policy.feeModel) > effCeiling
  ) {
    limitPrice = roundDownToTick(limitPrice - tick, tick);
  }
  if (limitPrice < ask) {
    skip(windowId, `limit below ask after fee/edge caps`);
    return null;
  }

  // ── Size the stake (fractional Kelly, same as the paper policy) ──────
  let balance: number;
  if (cfg.dryRun) {
    balance = cfg.bankrollCapUsd;
  } else {
    try {
      balance = await venue.getBalanceUsd();
    } catch (err) {
      skip(windowId, `balance unavailable: ${err}`);
      return null;
    }
  }
  const bankroll = Math.min(balance, cfg.bankrollCapUsd);
  const stakeFraction = Math.min(
    policy.maxStakeFraction,
    policy.kellyFraction * kellyFraction(pSide, effAsk)
  );
  const stakeUsd = Math.min(stakeFraction * bankroll, cfg.maxStakeUsd, balance);
  if (stakeUsd < cfg.minStakeUsd) {
    skip(
      windowId,
      `stake $${stakeUsd.toFixed(2)} below min $${cfg.minStakeUsd}`
    );
    return null;
  }
  // Size the order to the dollars VISIBLY fillable at or below the limit —
  // IOC would cancel the remainder anyway, and the dry-run record must not
  // pretend deeper fills than the book showed. (This is the side instrument's
  // own book, so its asks are walked directly via the UP path of fillSide.)
  const fillable = fillSide('UP', stakeUsd, undefined, top!.asks, limitPrice);
  if (!fillable || fillable.stake < cfg.minStakeUsd) {
    skip(
      windowId,
      `book too thin within limit (fillable $${(fillable?.stake ?? 0).toFixed(2)})`
    );
    return null;
  }
  const orderUsd = fillable.stake;
  if (orderUsd / limitPrice < inst.minOrderSize) {
    skip(
      windowId,
      `stake $${orderUsd.toFixed(2)} under market min size (${inst.minOrderSize} shares)`
    );
    return null;
  }

  // ── Place the order (or record the shadow fill) ──────────────────────
  // Mark attempted BEFORE posting: if the post's outcome is ever ambiguous
  // (timeout after send), the failure mode is a missed trade, not a double one.
  seen.add(windowId);

  const base: TradeRecord = {
    id: windowId,
    crypto: r.crypto,
    rangeId: r.id,
    slug: r.market.slug,
    windowStart: r.windowStart,
    windowEnd: r.windowEnd,
    side: c.side,
    tokenId: inst.key,
    outcomeIndex: inst.outcomeIndex,
    conditionId: inst.conditionId,
    negRisk: inst.negRisk,
    pSide,
    edge,
    quotedCost: ask,
    feeBps,
    limitPrice,
    intendedUsd: orderUsd,
    status: 'dry-run',
    placedAt: new Date(now).toISOString(),
  };

  if (cfg.dryRun) {
    // Shadow fill = walking the visible book, with the taker fee folded into
    // the effective cost (Polymarket takes buy fees in outcome tokens; Kalshi
    // takes a cash fee on top — feeAdjustedCost models whichever applies).
    const effCost = feeAdjustedCost(fillable.cost, feeBps, policy.feeModel);
    const trade: TradeRecord = {
      ...base,
      costUsd: orderUsd,
      shares: orderUsd / effCost,
      avgPrice: effCost,
    };
    await recordTrade(trade);
    console.log(
      `[trade] DRY-RUN ${windowId} BUY ${c.side} $${orderUsd.toFixed(2)} ` +
        `@ ${effCost.toFixed(3)} incl ${feeBps}bps fee (edge ${edge.toFixed(3)})`
    );
    return trade;
  }

  const placed = await venue.placeOrder(inst, {
    usd: orderUsd,
    limitPrice,
    feeBps,
  });

  const trade: TradeRecord = {
    ...base,
    status: placed.status,
    orderId: placed.orderId,
    costUsd: placed.costUsd,
    shares: placed.shares,
    avgPrice:
      placed.shares && placed.costUsd
        ? placed.costUsd / placed.shares
        : undefined,
    error: placed.error,
  };
  await recordTrade(trade);
  if (trade.status === 'filled' || trade.status === 'partial') {
    console.log(
      `[trade] ${trade.status.toUpperCase()} ${windowId} BUY ${c.side} ` +
        `$${trade.costUsd!.toFixed(2)} → ${trade.shares!.toFixed(2)} shares ` +
        `@ ${(trade.costUsd! / trade.shares!).toFixed(3)} (edge ${edge.toFixed(3)})`
    );
  } else {
    console.warn(
      `[trade] ${trade.status} ${windowId}: ${trade.error ?? 'no fill'}`
    );
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
