/**
 * Edge report: does the model's accuracy survive contact with TRADABLE prices?
 *
 * Hit rate vs a coin flip pays nothing — a bet only has value if our
 * probability beats the price the order book would actually fill at:
 *   - betting UP   costs the UP token's best ask
 *   - betting DOWN costs 1 - the UP token's best bid
 *
 * For every resolved ledger entry this script computes the edge
 * (model probability of our side minus its cost) and the simulated P&L of
 * staking $1 of payout at that cost, then reports per family:
 *   - rows with REAL commit-time bid/ask (recorded going forward) — the truth
 *   - legacy rows with only a midpoint — a sensitivity sweep over assumed
 *     half-spreads, showing whether the apparent edge survives realistic costs
 *   - an edge-threshold sweep: only "take" bets whose edge exceeds t, the
 *     abstention discipline that converts calibration into profit
 *
 * Usage:  bun run edge [-- --live-only]
 */
import type { LedgerEntry, RangeId } from '../src/shared/types.ts';

const PATH = process.env.LEDGER_PATH ?? `${process.cwd()}/data/ledger.json`;
const LIVE_ONLY = process.argv.includes('--live-only');

const FAMILIES: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];
/** Assumed half-spreads (¢) for legacy midpoint-only rows. */
const ASSUMED_SPREADS = [0, 0.01, 0.02, 0.03];
/** Minimum-edge thresholds for the abstention sweep. */
const THRESHOLDS = [0, 0.02, 0.05, 0.1];

interface Bet {
  family: RangeId;
  /** Model probability of the side we picked. */
  pSide: number;
  /** Cost (0..1) per $1 of payout to take that side. */
  cost: number;
  won: boolean;
  /** True when cost came from a real commit-time order book. */
  tradable: boolean;
}

/** Cost of taking `side` given UP-token prices; undefined if not computable. */
function costOfSide(
  side: 'UP' | 'DOWN',
  bidUp: number | undefined,
  askUp: number | undefined
): number | undefined {
  const c = side === 'UP' ? askUp : bidUp !== undefined ? 1 - bidUp : undefined;
  return c !== undefined && c > 0 && c < 1 ? c : undefined;
}

function toBet(e: LedgerEntry, assumedSpread: number): Bet | undefined {
  if (e.outcome == null || e.correct == null) return undefined;
  const pSide = e.side === 'UP' ? e.probUp : 1 - e.probUp;
  const real = costOfSide(e.side, e.marketBidUp, e.marketAskUp);
  let cost = real;
  if (cost === undefined && e.marketImpliedUp !== undefined) {
    const midSide = e.side === 'UP' ? e.marketImpliedUp : 1 - e.marketImpliedUp;
    cost = Math.min(0.99, Math.max(0.01, midSide + assumedSpread));
  }
  if (cost === undefined) return undefined;
  return {
    family: e.rangeId,
    pSide,
    cost,
    won: e.correct === true,
    tradable: real !== undefined,
  };
}

interface Agg {
  n: number;
  wins: number;
  stake: number;
  pnl: number;
  edgeSum: number;
}

function aggregate(bets: Bet[], minEdge: number): Agg {
  const a: Agg = { n: 0, wins: 0, stake: 0, pnl: 0, edgeSum: 0 };
  for (const b of bets) {
    const edge = b.pSide - b.cost;
    if (edge < minEdge) continue; // abstain
    a.n++;
    if (b.won) a.wins++;
    a.stake += b.cost;
    a.pnl += b.won ? 1 - b.cost : -b.cost;
    a.edgeSum += edge;
  }
  return a;
}

function fmtRow(label: string, a: Agg): string {
  if (a.n === 0) return `  ${label.padEnd(18)}     —`;
  const hit = ((100 * a.wins) / a.n).toFixed(1).padStart(5);
  const edge = ((100 * a.edgeSum) / a.n).toFixed(1).padStart(5);
  const roi = ((100 * a.pnl) / a.stake).toFixed(1).padStart(6);
  const pnl = a.pnl.toFixed(2).padStart(8);
  return `  ${label.padEnd(18)} n=${String(a.n).padStart(4)}  hit=${hit}%  avgEdge=${edge}¢  pnl=$${pnl}  roi=${roi}%`;
}

const store = (await Bun.file(PATH).json()) as Record<string, LedgerEntry>;
let entries = Object.values(store).filter(e => e.outcome != null);
if (LIVE_ONLY) entries = entries.filter(e => e.source !== 'backfill');

const withBook = entries.filter(
  e => costOfSide(e.side, e.marketBidUp, e.marketAskUp) !== undefined
);
const nTrades = withBook.filter(e => e.bookSource === 'trades').length;
console.log(
  `${entries.length} resolved entries (${withBook.length} with real tradable prices: ` +
    `${withBook.length - nTrades} live book, ${nTrades} fill-derived backfill)\n`
);

// Quote staleness audit for rows with a real book read.
const lags = withBook
  .filter(e => e.marketQuotedAt)
  .map(e => (Date.parse(e.decidedAt) - Date.parse(e.marketQuotedAt!)) / 1000);
if (lags.length) {
  const sorted = [...lags].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)]!;
  console.log(
    `quote staleness (decidedAt - quotedAt): median ${med.toFixed(1)}s, max ${sorted[sorted.length - 1]!.toFixed(1)}s\n`
  );
}

for (const fam of FAMILIES) {
  const famEntries = entries.filter(e => e.rangeId === fam);
  if (!famEntries.length) continue;
  console.log(`── ${fam} ${'─'.repeat(60)}`);

  const real = famEntries
    .map(e => toBet(e, 0))
    .filter((b): b is Bet => b !== undefined && b.tradable);
  if (real.length) {
    console.log('  real order-book costs:');
    console.log(fmtRow('  take all', aggregate(real, 0)));
  } else {
    console.log('  real order-book costs: none yet (accumulates from now on)');
  }

  console.log('  legacy midpoint + assumed half-spread:');
  for (const s of ASSUMED_SPREADS) {
    const bets = famEntries
      .map(e => toBet(e, s))
      .filter((b): b is Bet => b !== undefined && !b.tradable);
    if (!bets.length) break;
    console.log(
      fmtRow(`  +${(100 * s).toFixed(0)}¢ spread`, aggregate(bets, 0))
    );
  }

  // Abstention sweep at a realistic assumed spread (2¢) incl. real-book rows.
  const all = famEntries
    .map(e => toBet(e, 0.02))
    .filter((b): b is Bet => b !== undefined);
  if (all.length) {
    console.log('  min-edge threshold (2¢ assumed spread on legacy rows):');
    for (const t of THRESHOLDS) {
      console.log(
        fmtRow(`  edge > ${(100 * t).toFixed(0)}¢`, aggregate(all, t))
      );
    }
  }
  console.log();
}

console.log(
  'pnl = profit per $1-payout contracts; roi = pnl / total stake.\n' +
    'Legacy rows price at midpoint ± assumed spread — treat as bounds, not truth.\n' +
    'The "real order-book" section is the verdict; it grows as live commits accrue.'
);
