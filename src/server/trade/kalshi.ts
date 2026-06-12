// Authenticated Kalshi trade-API client. Kalshi auth is two static secrets —
// an API key id plus an RSA private key — and every request carries an
// RSA-PSS-SHA256 signature of `${timestampMs}${METHOD}${path}` (path WITHOUT
// the query string, WITH the /trade-api/v2 prefix). No session, no derived
// credentials, nothing on-chain: cash settlement means there is no allowance
// setup and no redemption step at all.

import {
  constants,
  createPrivateKey,
  createSign,
  type KeyObject,
} from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getTradeConfig } from './config.ts';

let keyCache: KeyObject | null = null;

/** The configured RSA signing key, or null when no Kalshi creds are set. */
function signingKey(): KeyObject | null {
  if (keyCache) return keyCache;
  const cfg = getTradeConfig();
  let pem = cfg.kalshiPrivateKey;
  if (!pem && cfg.kalshiPrivateKeyPath) {
    pem = readFileSync(cfg.kalshiPrivateKeyPath, 'utf8');
  }
  if (!pem) return null;
  // .env files commonly store the PEM on one line with literal \n.
  pem = pem.replace(/\\n/g, '\n');
  keyCache = createPrivateKey(pem);
  return keyCache;
}

/** True when the Kalshi credentials needed for live trading are configured. */
export function hasKalshiCreds(): boolean {
  const cfg = getTradeConfig();
  return Boolean(
    cfg.kalshiApiKeyId && (cfg.kalshiPrivateKey || cfg.kalshiPrivateKeyPath)
  );
}

/** Signed request to the Kalshi trade API. Throws on missing creds / non-2xx. */
async function kalshiFetch<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const cfg = getTradeConfig();
  const key = signingKey();
  if (!cfg.kalshiApiKeyId || !key) {
    throw new Error(
      'KALSHI_API_KEY_ID / KALSHI_PRIVATE_KEY not set — cannot trade live'
    );
  }
  const base = new URL(cfg.kalshiApiUrl);
  // Sign the full path (prefix included), without any query string.
  const fullPath = `${base.pathname.replace(/\/$/, '')}${path.split('?')[0]}`;
  const ts = String(Date.now());
  const signer = createSign('RSA-SHA256');
  signer.update(ts + method + fullPath);
  const signature = signer.sign(
    {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    },
    'base64'
  );
  const res = await fetch(`${cfg.kalshiApiUrl}${path}`, {
    method,
    headers: {
      'KALSHI-ACCESS-KEY': cfg.kalshiApiKeyId,
      'KALSHI-ACCESS-TIMESTAMP': ts,
      'KALSHI-ACCESS-SIGNATURE': signature,
      'Content-Type': 'application/json',
      'User-Agent': 'bitcoin-predict/1.0',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`kalshi ${res.status} ${method} ${path}: ${text}`);
  }
  return res.json() as Promise<T>;
}

/** Spendable cash balance (in dollars) as Kalshi sees it. */
export async function getKalshiBalanceUsd(): Promise<number> {
  const data = await kalshiFetch<{ balance?: number }>(
    'GET',
    '/portfolio/balance'
  );
  const cents = Number(data?.balance);
  if (!Number.isFinite(cents)) throw new Error('balance unavailable');
  return cents / 100;
}

export interface KalshiOrderResult {
  orderId?: string;
  /** Contracts filled. */
  filled: number;
  /** Dollars spent on the fill, INCLUDING taker fees. */
  costUsd: number;
  /** Taker fees included in costUsd, for logging. */
  feesUsd: number;
}

interface KalshiOrder {
  order_id?: string;
  status?: string;
  fill_count_fp?: string;
  taker_fill_cost_dollars?: string;
  taker_fees_dollars?: string;
}

/**
 * Marketable-limit IOC buy: fill whatever rests at or below `priceDollars`,
 * cancel the remainder — the same semantics as the Polymarket executor's FAK
 * orders. `count` is whole contracts (each pays $1 on a win).
 */
export async function placeKalshiIocBuy(
  ticker: string,
  side: 'yes' | 'no',
  count: number,
  priceDollars: number
): Promise<KalshiOrderResult> {
  const price = priceDollars.toFixed(4);
  const body: Record<string, unknown> = {
    ticker,
    client_order_id: crypto.randomUUID(),
    action: 'buy',
    side,
    type: 'limit',
    count,
    time_in_force: 'immediate_or_cancel',
  };
  if (side === 'yes') body.yes_price_dollars = price;
  else body.no_price_dollars = price;

  const data = await kalshiFetch<{ order?: KalshiOrder }>(
    'POST',
    '/portfolio/orders',
    body
  );
  const o = data?.order;
  if (!o) throw new Error('order response missing order object');
  const filled = Number(o.fill_count_fp) || 0;
  const fillCost = Number(o.taker_fill_cost_dollars) || 0;
  const fees = Number(o.taker_fees_dollars) || 0;
  return {
    orderId: o.order_id,
    filled,
    costUsd: fillCost + fees,
    feesUsd: fees,
  };
}
