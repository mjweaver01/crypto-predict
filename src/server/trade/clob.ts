// Authenticated Polymarket CLOB client, built lazily and reused. Orders are
// EIP-712-signed locally with the wallet key; the L2 API credentials are
// derived from one L1 signature on first use (createOrDeriveApiKey), so the
// only secret that ever needs configuring is POLYMARKET_PRIVATE_KEY.

import { Wallet } from 'ethers';
import {
  AssetType,
  Chain,
  ClobClient,
  type ApiKeyCreds,
} from '@polymarket/clob-client';
import { getTradeConfig } from './config.ts';

let clientPromise: Promise<ClobClient> | null = null;

/** The trading wallet, or null when no key is configured. */
export function getWallet(): Wallet | null {
  const { privateKey } = getTradeConfig();
  if (!privateKey) return null;
  const key = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  return new Wallet(key);
}

/**
 * Authenticated CLOB client (singleton). Throws when no private key is set —
 * callers on the dry-run path must not reach this.
 */
export function getClobClient(): Promise<ClobClient> {
  if (clientPromise) return clientPromise;
  clientPromise = (async () => {
    const cfg = getTradeConfig();
    const wallet = getWallet();
    if (!wallet) {
      throw new Error('POLYMARKET_PRIVATE_KEY not set — cannot trade live');
    }
    // L1-only client first, to derive (or create) the L2 API credentials.
    const l1 = new ClobClient(cfg.clobUrl, Chain.POLYGON, wallet);
    const creds: ApiKeyCreds = await l1.createOrDeriveApiKey();
    return new ClobClient(
      cfg.clobUrl,
      Chain.POLYGON,
      wallet,
      creds,
      cfg.signatureType,
      cfg.funder ?? wallet.address
    );
  })();
  // A failed build must not poison every later attempt (e.g. transient 5xx).
  clientPromise.catch(() => {
    clientPromise = null;
  });
  return clientPromise;
}

/** Spendable USDC balance (in dollars) as the CLOB sees it. */
export async function getUsdcBalance(): Promise<number> {
  const client = await getClobClient();
  const res = await client.getBalanceAllowance({
    asset_type: AssetType.COLLATERAL,
  });
  const raw = Number(res?.balance);
  if (!Number.isFinite(raw)) throw new Error('balance unavailable');
  return raw / 1e6; // USDC has 6 decimals
}
