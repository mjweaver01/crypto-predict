// Live-trading configuration, read from env. Every knob defaults to the SAFE
// side: trading is off unless TRADING_ENABLED=true, and even then orders are
// dry-run (full decision path, no money) unless TRADING_DRY_RUN=false.
//
// Dry-run mode needs no wallet at all — it sizes against TRADE_BANKROLL_CAP_USD
// and simulates fills at the live ask, producing a faithful shadow record in
// data/trades.json before a single dollar is risked.

import { env } from '../cache.ts';
import type { RangeId } from '../../shared/types.ts';

export interface TradeConfig {
  /** Master switch — when false the entire trade layer is inert. */
  enabled: boolean;
  /** Run the full decision path but never post an order (default true). */
  dryRun: boolean;
  /** Polygon private key of the trading wallet (hex, with or without 0x). */
  privateKey: string;
  /**
   * Polymarket signature type: 0 = plain EOA (recommended for a bot wallet),
   * 1 = Magic/email proxy, 2 = browser-wallet Gnosis proxy. Proxy modes also
   * need POLYMARKET_FUNDER (the proxy address holding the funds).
   */
  signatureType: number;
  /** Proxy wallet address that holds funds/positions (proxy modes only). */
  funder?: string;
  /** Families allowed to trade (default: only 5m — the proven edge). */
  families: Set<RangeId>;
  /** Hard cap on USD spent on any single trade. */
  maxStakeUsd: number;
  /** Skip trades the sizing would put below this many dollars. */
  minStakeUsd: number;
  /** Kelly sizes against min(USDC balance, this cap) — bounds compounding. */
  bankrollCapUsd: number;
  /** Max ask deterioration vs the frozen commit-time cost before skipping. */
  maxSlippage: number;
  /** Max simultaneously open (unresolved) positions. */
  maxOpenTrades: number;
  /** Halt new trades for the rest of the UTC day after this realized loss. */
  dailyLossLimitUsd: number;
  /** Automatically redeem winning positions on-chain (EOA mode only). */
  autoRedeem: boolean;
  /** Polygon JSON-RPC endpoint for allowances and redemption. */
  rpcUrl: string;
  /** CLOB endpoint (same default as the market-data source). */
  clobUrl: string;
}

const RANGE_IDS: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

function num(key: string, fallback: number): number {
  const v = Number(env(key, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
}

export function getTradeConfig(): TradeConfig {
  const families = new Set<RangeId>(
    env('TRADE_FAMILIES', '5m')
      .split(',')
      .map(s => s.trim())
      .filter((s): s is RangeId => (RANGE_IDS as string[]).includes(s))
  );
  return {
    enabled: env('TRADING_ENABLED', 'false') === 'true',
    dryRun: env('TRADING_DRY_RUN', 'true') !== 'false',
    privateKey: env('POLYMARKET_PRIVATE_KEY', ''),
    signatureType: num('POLYMARKET_SIGNATURE_TYPE', 0),
    funder: env('POLYMARKET_FUNDER', '') || undefined,
    families,
    maxStakeUsd: num('TRADE_MAX_STAKE_USD', 10),
    minStakeUsd: num('TRADE_MIN_STAKE_USD', 1),
    bankrollCapUsd: num('TRADE_BANKROLL_CAP_USD', 250),
    maxSlippage: num('TRADE_MAX_SLIPPAGE', 0.01),
    maxOpenTrades: num('TRADE_MAX_OPEN', 4),
    dailyLossLimitUsd: num('TRADE_DAILY_LOSS_LIMIT_USD', 25),
    autoRedeem: env('TRADE_AUTO_REDEEM', 'true') !== 'false',
    rpcUrl: env('POLYGON_RPC_URL', 'https://polygon-bor-rpc.publicnode.com'),
    clobUrl: env('POLYMARKET_CLOB_URL', 'https://clob.polymarket.com'),
  };
}

// ── Polygon contract addresses (Polymarket production) ─────────────────────
/** Bridged USDC.e — the CLOB's collateral token (6 decimals). */
export const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
/** Gnosis ConditionalTokens framework (outcome tokens + redemption). */
export const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
/** Polymarket CTF exchange (standard binary markets). */
export const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
/** Polymarket neg-risk CTF exchange. */
export const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
/** Polymarket neg-risk adapter (redemption path for neg-risk markets). */
export const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
