// On-chain redemption: winning outcome tokens don't turn back into USDC by
// themselves — someone must call redeemPositions on the ConditionalTokens
// contract (or the neg-risk adapter). Polymarket's UI does this when you click
// "claim"; an unattended trader has to do it itself or its USDC balance only
// ever drains. Requires the trading wallet to be a plain EOA (signature type
// 0) holding a little POL for gas — proxy-wallet accounts should claim via the
// Polymarket UI instead.

import { Contract, providers, Wallet } from 'ethers';
import {
  CTF_ADDRESS,
  NEG_RISK_ADAPTER,
  USDC_ADDRESS,
  getTradeConfig,
} from './config.ts';
import { getWallet } from './clob.ts';
import { getTrades, updateTrade } from './tradeLog.ts';
import type { TradeRecord } from '../../shared/types.ts';

const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
  'function balanceOf(address owner, uint256 id) view returns (uint256)',
];
const NEG_RISK_ABI = [
  'function redeemPositions(bytes32 conditionId, uint256[] amounts)',
];

const ZERO32 = '0x' + '0'.repeat(64);

function connectedWallet(): Wallet | null {
  const cfg = getTradeConfig();
  const wallet = getWallet();
  if (!wallet) return null;
  return wallet.connect(new providers.JsonRpcProvider(cfg.rpcUrl));
}

/** Trades whose winnings are still locked in outcome tokens. */
function redeemable(t: TradeRecord): boolean {
  return (
    t.won === true &&
    t.status !== 'dry-run' &&
    (t.shares ?? 0) > 0 &&
    t.conditionId !== undefined &&
    t.redeemTx === undefined
  );
}

/**
 * Redeem every settled, won, unredeemed position. Groups by condition id so a
 * condition is redeemed once even if several trades share it. Returns the
 * number of conditions redeemed. EOA wallets only.
 */
export async function redeemSettled(): Promise<number> {
  const cfg = getTradeConfig();
  if (!cfg.enabled || cfg.dryRun || !cfg.autoRedeem) return 0;
  if (cfg.signatureType !== 0) return 0; // proxy wallets claim via the UI

  const pending = (await getTrades()).filter(redeemable);
  if (pending.length === 0) return 0;

  const wallet = connectedWallet();
  if (!wallet) return 0;
  const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);

  const byCondition = new Map<string, TradeRecord[]>();
  for (const t of pending) {
    const group = byCondition.get(t.conditionId!) ?? [];
    group.push(t);
    byCondition.set(t.conditionId!, group);
  }

  let redeemed = 0;
  for (const [conditionId, group] of byCondition) {
    try {
      let txHash: string;
      if (group[0]!.negRisk) {
        // The neg-risk adapter takes explicit amounts per outcome index.
        const amounts = [0n, 0n] as [bigint, bigint];
        for (const t of group) {
          const bal = (await ctf.balanceOf(wallet.address, t.tokenId)) as {
            toBigInt(): bigint;
          };
          amounts[t.outcomeIndex as 0 | 1] = bal.toBigInt();
        }
        if (amounts[0] === 0n && amounts[1] === 0n) {
          // Nothing on-chain to redeem (already claimed elsewhere) — mark done.
          for (const t of group) {
            await updateTrade(t.id, {
              redeemTx: 'none',
              redeemedAt: new Date().toISOString(),
            });
          }
          continue;
        }
        const adapter = new Contract(NEG_RISK_ADAPTER, NEG_RISK_ABI, wallet);
        const tx = await adapter.redeemPositions(conditionId, amounts);
        await tx.wait();
        txHash = tx.hash as string;
      } else {
        // Standard binary CTF market: index sets [1, 2] redeem whatever
        // balance the wallet holds of either outcome.
        const tx = await ctf.redeemPositions(
          USDC_ADDRESS,
          ZERO32,
          conditionId,
          [1, 2]
        );
        await tx.wait();
        txHash = tx.hash as string;
      }
      const at = new Date().toISOString();
      for (const t of group) {
        await updateTrade(t.id, { redeemTx: txHash, redeemedAt: at });
      }
      console.log(`[trade] redeemed ${conditionId.slice(0, 10)}… (${txHash})`);
      redeemed++;
    } catch (err) {
      console.warn(`[trade] redeem failed for ${conditionId}:`, err);
    }
  }
  return redeemed;
}
