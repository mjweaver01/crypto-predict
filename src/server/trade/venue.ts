// Execution venue abstraction: the platform-specific half of the trade
// executor. The executor owns the DECISION (edge gates, slippage caps, Kelly
// sizing, rails); a Venue owns the MECHANICS — resolving which instrument a
// side maps to, reading that instrument's live book, quoting its fee, and
// posting a marketable-limit immediate-or-cancel buy.
//
// Both venues normalise to the same contract: prices are 0..1 per $1 of
// payout, books are quoted FOR THE SIDE BEING BOUGHT (asks = what a buy
// lifts), and a placed order reports all-in cost + the shares actually held.

import { OrderType, Side as ClobSide } from '@polymarket/clob-client';
import * as pm from '../sources/polymarket.ts';
import * as kalshiData from '../sources/kalshi.ts';
import { feeAdjustedCost } from '../model/paper.ts';
import { getClobClient, getUsdcBalance } from './clob.ts';
import { getKalshiBalanceUsd, placeKalshiIocBuy } from './kalshi.ts';
import { getTradeConfig } from './config.ts';
import type { PlatformId } from '../sources/market.ts';
import type { BookLevel, Side, TradeStatus } from '../../shared/types.ts';

/** The venue-specific instrument a (market, side) pair resolves to. */
export interface VenueInstrument {
  /** Stable id recorded on the TradeRecord (CLOB token id / `ticker|side`). */
  key: string;
  /** 0 = Up, 1 = Down (position in the market's outcome list). */
  outcomeIndex: number;
  /** Price tick the venue accepts for limit prices. */
  tickSize: number;
  /** Minimum order size in shares/contracts. */
  minOrderSize: number;
  /** Polymarket-only: CTF condition id (on-chain redemption). */
  conditionId?: string;
  /** Polymarket-only: trades on the neg-risk exchange. */
  negRisk?: boolean;
}

export interface VenueBook {
  bid?: number;
  ask?: number;
  bids: BookLevel[];
  /** Cost levels a buy of this side lifts, best (cheapest) first. */
  asks: BookLevel[];
  quotedAt?: string;
}

export interface PlacedOrder {
  status: TradeStatus;
  orderId?: string;
  /** Dollars actually spent, all-in (Kalshi fees are cash, so included). */
  costUsd?: number;
  /** Outcome shares/contracts actually held after fees. */
  shares?: number;
  error?: string;
}

export interface Venue {
  id: PlatformId;
  /** Resolve the instrument `side` buys on `marketId`, or null if unknown. */
  resolveInstrument(
    marketId: string,
    side: Side
  ): Promise<VenueInstrument | null>;
  /** Live book of the side instrument (asks = buy costs for that side). */
  fetchBook(inst: VenueInstrument): Promise<VenueBook | undefined>;
  /** Taker fee in bps under the venue's fee model (see paper.feeModel). */
  fetchFeeBps(inst: VenueInstrument): Promise<number>;
  /** Spendable balance in dollars. */
  getBalanceUsd(): Promise<number>;
  /** Marketable-limit IOC buy of up to `usd` at `limitPrice`. */
  placeOrder(
    inst: VenueInstrument,
    args: { usd: number; limitPrice: number; feeBps: number }
  ): Promise<PlacedOrder>;
}

// ── Polymarket ──────────────────────────────────────────────────────────────

const polymarketVenue: Venue = {
  id: 'polymarket',

  async resolveInstrument(slug, side) {
    const tokens = await pm.fetchMarketTokens(slug).catch(() => null);
    if (!tokens || tokens.tokenIds.length !== 2) return null;
    const outcomeIndex = side === 'UP' ? tokens.upIndex : 1 - tokens.upIndex;
    const tokenId = tokens.tokenIds[outcomeIndex];
    if (!tokenId) return null;
    return {
      key: tokenId,
      outcomeIndex,
      tickSize: tokens.tickSize && tokens.tickSize > 0 ? tokens.tickSize : 0.01,
      minOrderSize: tokens.minOrderSize ?? 0,
      conditionId: tokens.conditionId,
      negRisk: tokens.negRisk,
    };
  },

  async fetchBook(inst) {
    // The side token has its own book; its asks are already the buy costs.
    return pm.bookTop(inst.key).catch(() => undefined);
  },

  async fetchFeeBps(inst) {
    return pm.fetchFeeBps(inst.key);
  },

  async getBalanceUsd() {
    return getUsdcBalance();
  },

  async placeOrder(inst, { usd, limitPrice, feeBps }) {
    let status: TradeStatus = 'failed';
    let orderId: string | undefined;
    let costUsd: number | undefined;
    let shares: number | undefined;
    let error: string | undefined;
    try {
      const client = await getClobClient();
      const order = await client.createMarketOrder(
        {
          tokenID: inst.key,
          side: ClobSide.BUY,
          amount: usd,
          price: limitPrice,
          orderType: OrderType.FAK,
        },
        {
          tickSize: String(inst.tickSize) as
            | '0.1'
            | '0.01'
            | '0.001'
            | '0.0001',
          negRisk: inst.negRisk === true,
        }
      );
      const res = (await client.postOrder(order, OrderType.FAK)) as {
        success?: boolean;
        errorMsg?: string;
        orderID?: string;
        makingAmount?: string;
        takingAmount?: string;
      };
      orderId = res?.orderID;
      if (res?.success) {
        // For a BUY, makingAmount is the USD spent and takingAmount the
        // matched shares. The taker fee is collected in outcome tokens on top
        // of the match, so net the estimated fee out of the recorded position
        // — P&L and redemption accounting must reflect shares actually held.
        costUsd = Number(res.makingAmount) || 0;
        const matched = Number(res.takingAmount) || 0;
        if (matched > 0 && costUsd > 0) {
          const px = costUsd / matched;
          shares =
            matched * (1 - ((feeBps / 10_000) * Math.min(px, 1 - px)) / px);
        } else {
          shares = 0;
        }
        status =
          shares > 0
            ? costUsd >= usd * 0.99
              ? 'filled'
              : 'partial'
            : 'unfilled';
      } else {
        error = res?.errorMsg || 'order rejected';
      }
    } catch (err) {
      error = String(err);
    }
    return { status, orderId, costUsd, shares, error };
  },
};

// ── Kalshi ──────────────────────────────────────────────────────────────────

function kalshiParts(inst: VenueInstrument): {
  ticker: string;
  side: 'yes' | 'no';
} {
  const [ticker, side] = inst.key.split('|');
  return { ticker: ticker!, side: side === 'no' ? 'no' : 'yes' };
}

const kalshiVenue: Venue = {
  id: 'kalshi',

  async resolveInstrument(ticker, side) {
    // Up/down maps 1:1 onto the binary market's yes/no — no token lookup
    // needed, but verify the market actually exists before trading it.
    const meta = await kalshiData.fetchMarketMeta(ticker).catch(() => null);
    if (!meta) return null;
    return {
      key: `${ticker}|${side === 'UP' ? 'yes' : 'no'}`,
      outcomeIndex: side === 'UP' ? 0 : 1,
      // Kalshi's grid is tapered (0.001 at the tails) but every 1¢ multiple
      // is valid everywhere, so quoting in cents is always safe.
      tickSize: 0.01,
      minOrderSize: 1,
    };
  },

  async fetchBook(inst) {
    const { ticker, side } = kalshiParts(inst);
    const top = await kalshiData.bookTop(ticker).catch(() => undefined);
    if (!top) return undefined;
    if (side === 'yes') return top;
    // NO-side view of the same book: a resting YES buy at p is what a NO
    // taker lifts at 1−p, and vice versa.
    const flip = (levels: BookLevel[]): BookLevel[] =>
      levels.map(l => ({ p: 1 - l.p, s: l.s }));
    const bids = flip(top.asks); // descending from the best NO bid
    const asks = flip(top.bids); // ascending from the best NO ask
    return {
      bid: bids[0]?.p,
      ask: asks[0]?.p,
      bids,
      asks,
      quotedAt: top.quotedAt,
    };
  },

  async fetchFeeBps(inst) {
    const { ticker } = kalshiParts(inst);
    return kalshiData.fetchFeeBps(kalshiData.seriesOf(ticker));
  },

  async getBalanceUsd() {
    return getKalshiBalanceUsd();
  },

  async placeOrder(inst, { usd, limitPrice, feeBps }) {
    const { ticker, side } = kalshiParts(inst);
    // Fees are cash on top of the price, so the contract count must leave
    // room for them inside the stake budget.
    const effPrice = feeAdjustedCost(limitPrice, feeBps, 'quadratic');
    const count = Math.floor(usd / effPrice);
    if (count < 1) {
      return { status: 'failed', error: 'stake below one contract' };
    }
    try {
      const res = await placeKalshiIocBuy(ticker, side, count, limitPrice);
      const status: TradeStatus =
        res.filled > 0
          ? res.filled >= count - 1e-9
            ? 'filled'
            : 'partial'
          : 'unfilled';
      return {
        status,
        orderId: res.orderId,
        costUsd: res.costUsd,
        shares: res.filled,
      };
    } catch (err) {
      return { status: 'failed', error: String(err) };
    }
  },
};

/** The venue for the configured trading platform. */
export function getVenue(): Venue {
  return getTradeConfig().platform === 'kalshi' ? kalshiVenue : polymarketVenue;
}
