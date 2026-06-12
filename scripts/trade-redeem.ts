// Manually redeem settled winning positions back into USDC.
// Run with: bun run trade:redeem
// (The server does this automatically every resolve cycle when
// TRADE_AUTO_REDEEM is on; this is for catching up after downtime.)

import { settleTrades } from '../src/server/trade/tradeLog.ts';
import { redeemSettled } from '../src/server/trade/redeem.ts';

import { getPlatform } from '../src/server/sources/market.ts';

if (getPlatform() === 'kalshi') {
  console.error(
    'This script is Polymarket-only. TRADING_PLATFORM=kalshi needs no ' +
      'on-chain setup or redemption — fund your Kalshi account and set ' +
      'KALSHI_API_KEY_ID + KALSHI_PRIVATE_KEY instead.'
  );
  process.exit(1);
}

const settled = await settleTrades();
const redeemed = await redeemSettled();
console.log(`Settled ${settled} trade(s), redeemed ${redeemed} condition(s).`);
