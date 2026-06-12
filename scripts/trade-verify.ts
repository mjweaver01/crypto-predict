/**
 * Cross-check every live trade against the Polymarket data API to confirm fills
 * and surface on-chain transaction hashes.
 *
 * For each filled/partial trade the script:
 *   1. Queries data-api /trades?market=<conditionId>&maker_address=<wallet>
 *   2. Matches fills by orderId (or timestamp proximity as a fallback)
 *   3. Patches the record with fillTxHashes, verifiedCostUsd, verifiedShares,
 *      verifyStatus ('match' | 'mismatch' | 'notfound' | 'error'), verifyNote
 *
 * Usage:  bun run trade:verify [-- --dry]
 */
import { verifyTrades } from '../src/server/trade/verify.ts';

const DRY = process.argv.includes('--dry');
if (DRY) {
  console.log(
    '[verify] dry-run flag detected — not supported; run without --dry to patch records'
  );
  process.exit(0);
}

console.log('[verify] querying Polymarket data API for fill confirmation…');
const counts = await verifyTrades();
console.log(
  `\n[verify] done — ${counts.processed} trade(s) processed` +
    `\n  ✓ match:    ${counts.match}` +
    `\n  ⚠ mismatch: ${counts.mismatch}` +
    `\n  ? notfound: ${counts.notfound}` +
    `\n  ✗ error:    ${counts.error}`
);
if (counts.mismatch > 0) {
  console.warn(
    '\n[verify] ⚠  Mismatches found — check data/trades.json for verifyNote details.'
  );
}
