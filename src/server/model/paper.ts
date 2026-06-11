// Paper trading: the EV decision layer, simulated with no money at risk.
//
// A calibrated probability only becomes a strategy once two questions are
// answered per call: is the edge over the TRADABLE price big enough to bet,
// and how much? This module answers both — a minimum-edge gate over the
// commit-time order book, and fractional Kelly sizing — and replays the policy
// over the resolved ledger to produce an equity curve.
//
// Deliberately stateless: the ledger stays the single source of truth, and the
// whole simulation is a deterministic pure function of (entries, policy). That
// makes the scoreboard auditable and lets a policy change re-score all history
// instead of forking a second record. Only entries carrying REAL commit-time
// bid/ask are evaluated — midpoint-only legacy rows are not bankable evidence.

import { env } from '../cache.ts';
import type {
  LedgerEntry,
  PaperBet,
  PaperDecision,
  PaperFamilyStats,
  PaperPolicy,
  PaperResponse,
  RangeId,
  Side,
} from '../../shared/types.ts';

export function getPolicy(): PaperPolicy {
  const num = (key: string, fallback: number) => {
    const v = Number(env(key, String(fallback)));
    return Number.isFinite(v) ? v : fallback;
  };
  // Per-family edge gates, calibrated by the backfilled edge report: 5m has
  // measured tradable edge at 2¢; the others were flat-to-negative below 5¢,
  // so they carry the higher bar until they prove otherwise. PAPER_MIN_EDGE
  // (if set) overrides any family without its own PAPER_MIN_EDGE_<FAM>.
  const baseRaw = env('PAPER_MIN_EDGE', '');
  const base = baseRaw === '' ? NaN : Number(baseRaw); // Number('') is 0!
  const fam = (key: string, fallback: number) =>
    num(key, Number.isFinite(base) ? base : fallback);
  return {
    startBankroll: num('PAPER_START_BANKROLL', 1000),
    minEdge: {
      '5m': fam('PAPER_MIN_EDGE_5M', 0.02),
      '15m': fam('PAPER_MIN_EDGE_15M', 0.05),
      '1h': fam('PAPER_MIN_EDGE_1H', 0.05),
      '4h': fam('PAPER_MIN_EDGE_4H', 0.05),
      '1d': fam('PAPER_MIN_EDGE_1D', 0.05),
    },
    kellyFraction: num('PAPER_KELLY_FRACTION', 0.25),
    // A ~6% edge does not justify 10% swings: the backfilled replay hit a 48%
    // drawdown at 0.10. Half the cap costs little growth, halves the pain.
    maxStakeFraction: num('PAPER_MAX_STAKE_FRACTION', 0.05),
  };
}

/**
 * Cost (0..1) per $1 of payout to take `side`, given the UP token's book:
 * buying Up fills at the ask; buying Down is equivalent to selling Up at the
 * bid, i.e. costs 1 − bid. Undefined when the needed side of the book is empty.
 */
export function costOfSide(
  side: Side,
  bidUp: number | undefined,
  askUp: number | undefined
): number | undefined {
  const c = side === 'UP' ? askUp : bidUp !== undefined ? 1 - bidUp : undefined;
  return c !== undefined && c > 0 && c < 1 ? c : undefined;
}

/**
 * Full-Kelly stake fraction for a binary contract costing `cost` with win
 * probability `p`: f* = p − (1−p)·cost/(1−cost). Zero when the edge is gone.
 */
export function kellyFraction(p: number, cost: number): number {
  return Math.max(0, p - ((1 - p) * cost) / (1 - cost));
}

/** The EV verdict for one committed call against its frozen book. */
export function decideBet(
  probUp: number,
  side: Side,
  family: RangeId,
  bidUp: number | undefined,
  askUp: number | undefined,
  policy: PaperPolicy = getPolicy()
): PaperDecision {
  const cost = costOfSide(side, bidUp, askUp);
  if (cost === undefined) {
    return { action: 'PASS', side, stakeFraction: 0, reason: 'no-book' };
  }
  const pSide = side === 'UP' ? probUp : 1 - probUp;
  const edge = pSide - cost;
  if (edge < policy.minEdge[family]) {
    return {
      action: 'PASS',
      side,
      cost,
      edge,
      stakeFraction: 0,
      reason: 'edge-below-min',
    };
  }
  const stakeFraction = Math.min(
    policy.maxStakeFraction,
    policy.kellyFraction * kellyFraction(pSide, cost)
  );
  return { action: 'BET', side, cost, edge, stakeFraction };
}

const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

/**
 * Replay the policy over the ledger in commit order. Bets compound against a
 * running bankroll; open windows are listed (staked at the current bankroll)
 * but only resolved bets move equity.
 */
export function simulatePaper(
  entries: LedgerEntry[],
  policy: PaperPolicy = getPolicy()
): PaperResponse {
  const book = entries
    .filter(e => e.marketBidUp !== undefined || e.marketAskUp !== undefined)
    .sort((a, b) => Date.parse(a.decidedAt) - Date.parse(b.decidedAt));

  let bankroll = policy.startBankroll;
  let peak = bankroll;
  let maxDrawdown = 0;
  let passes = 0;
  let staked = 0;
  // Rows recorded before the bookSource field existed are live captures.
  const sources = { live: 0, trades: 0 };
  const bets: PaperBet[] = [];
  const open: PaperBet[] = [];
  const equity: { t: number; bankroll: number }[] = [];
  const families = new Map<RangeId, PaperFamilyStats>(
    RANGE_IDS.map(id => [
      id,
      { rangeId: id, bets: 0, wins: 0, staked: 0, pnl: 0, roi: 0 },
    ])
  );

  for (const e of book) {
    const d = decideBet(
      e.probUp,
      e.side,
      e.rangeId,
      e.marketBidUp,
      e.marketAskUp,
      policy
    );
    const resolved = e.outcome != null && e.correct != null;
    if (resolved) sources[e.bookSource === 'trades' ? 'trades' : 'live']++;
    if (d.action === 'PASS') {
      if (resolved) passes++;
      continue;
    }
    const cost = d.cost!;
    const pSide = e.side === 'UP' ? e.probUp : 1 - e.probUp;
    const stake = bankroll * d.stakeFraction;
    const bet: PaperBet = {
      id: e.id,
      rangeId: e.rangeId,
      decidedAt: e.decidedAt,
      windowEnd: e.windowEnd,
      side: e.side,
      cost,
      pSide,
      edge: d.edge!,
      stake,
    };
    if (!resolved) {
      open.push(bet);
      continue;
    }
    // Win pays (1−cost)/cost per dollar staked; a loss forfeits the stake.
    const won = e.correct === true;
    const pnl = won ? (stake * (1 - cost)) / cost : -stake;
    bankroll += pnl;
    peak = Math.max(peak, bankroll);
    if (peak > 0) maxDrawdown = Math.max(maxDrawdown, 1 - bankroll / peak);
    staked += stake;
    bet.pnl = pnl;
    bet.bankrollAfter = bankroll;
    bet.won = won;
    bets.push(bet);
    equity.push({ t: Date.parse(e.windowEnd), bankroll });
    const f = families.get(e.rangeId)!;
    f.bets++;
    if (won) f.wins++;
    f.staked += stake;
    f.pnl += pnl;
  }

  for (const f of families.values()) f.roi = f.staked ? f.pnl / f.staked : 0;
  const pnl = bankroll - policy.startBankroll;
  return {
    policy,
    summary: {
      bankroll,
      pnl,
      roi: staked ? pnl / staked : 0,
      maxDrawdown,
      bets: bets.length,
      wins: bets.filter(b => b.won).length,
      passes,
      evaluated: bets.length + passes,
      sources,
    },
    families: [...families.values()].filter(f => f.bets > 0),
    equity,
    bets: bets.reverse(),
    open: open.reverse(),
  };
}
