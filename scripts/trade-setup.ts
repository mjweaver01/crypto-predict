// One-time live-trading setup. Run with: bun run trade:setup [--check]
//
// What live trading needs, and what this script does:
//   1. A dedicated Polygon EOA wallet (POLYMARKET_PRIVATE_KEY) holding
//      USDC.e (bridged USDC — the CLOB's collateral) and a little POL for gas.
//      → prints both balances and the wallet address to fund.
//   2. L2 API credentials on the CLOB, derived from one wallet signature.
//      → createOrDeriveApiKey (idempotent), prints the masked key.
//   3. ERC-20 + ERC-1155 allowances so the exchange contracts can move your
//      USDC and outcome tokens when orders match.
//      → checks all six and sends the missing approvals (skipped with --check).
//
// Proxy-wallet accounts (signature type 1/2) already have allowances set by
// Polymarket; for those this script only derives API credentials.

import {
  BigNumber,
  Contract,
  constants,
  providers,
  Wallet,
  utils,
} from 'ethers';
import { Chain, ClobClient } from '@polymarket/clob-client';
import {
  CTF_ADDRESS,
  CTF_EXCHANGE,
  NEG_RISK_ADAPTER,
  NEG_RISK_EXCHANGE,
  USDC_ADDRESS,
  getTradeConfig,
} from '../src/server/trade/config.ts';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];
const CTF_ABI = [
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
  'function setApprovalForAll(address operator, bool approved)',
];

const SPENDERS: [string, string][] = [
  ['CTF Exchange', CTF_EXCHANGE],
  ['Neg-risk Exchange', NEG_RISK_EXCHANGE],
  ['Neg-risk Adapter', NEG_RISK_ADAPTER],
];

const checkOnly = process.argv.includes('--check');

const cfg = getTradeConfig();
if (!cfg.privateKey) {
  console.error(
    'POLYMARKET_PRIVATE_KEY is not set.\n' +
      'Create a DEDICATED wallet for the bot (never your main wallet), e.g.:\n' +
      '  bun -e "import {Wallet} from \'ethers\'; const w = Wallet.createRandom(); console.log(w.address, w.privateKey)"\n' +
      'then put the key in .env and fund the address with USDC.e + POL on Polygon.'
  );
  process.exit(1);
}

const provider = new providers.JsonRpcProvider(cfg.rpcUrl);
const key = cfg.privateKey.startsWith('0x')
  ? cfg.privateKey
  : `0x${cfg.privateKey}`;
const wallet = new Wallet(key, provider);

console.log(`Wallet:          ${wallet.address}`);
console.log(`Signature type:  ${cfg.signatureType}`);
if (cfg.funder) console.log(`Funder (proxy):  ${cfg.funder}`);

// ── Balances ────────────────────────────────────────────────────────────────
const usdc = new Contract(USDC_ADDRESS, ERC20_ABI, wallet);
const [pol, usdcBal] = await Promise.all([
  provider.getBalance(wallet.address),
  usdc.balanceOf(wallet.address) as Promise<BigNumber>,
]);
console.log(`POL (gas):       ${utils.formatEther(pol)}`);
console.log(`USDC.e:          ${utils.formatUnits(usdcBal, 6)}`);
if (pol.isZero()) {
  console.warn('⚠ No POL — approvals and redemptions need gas.');
}
if (usdcBal.isZero()) {
  console.warn('⚠ No USDC.e — fund the wallet before enabling live trading.');
}

// ── API credentials ─────────────────────────────────────────────────────────
const clob = new ClobClient(cfg.clobUrl, Chain.POLYGON, wallet);
const creds = await clob.createOrDeriveApiKey();
console.log(`CLOB API key:    ${creds.key.slice(0, 8)}… (derived OK)`);

// ── Allowances (EOA mode only) ──────────────────────────────────────────────
if (cfg.signatureType !== 0) {
  console.log('Proxy-wallet mode: allowances are managed by Polymarket. Done.');
  process.exit(0);
}

const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
for (const [name, spender] of SPENDERS) {
  const allowance = (await usdc.allowance(
    wallet.address,
    spender
  )) as BigNumber;
  const approved = (await ctf.isApprovedForAll(
    wallet.address,
    spender
  )) as boolean;

  const usdcOk = allowance.gt(BigNumber.from(10).pow(12)); // > $1M in 6 dp
  console.log(
    `${name}: USDC ${usdcOk ? '✓' : '✗'}  CTF ${approved ? '✓' : '✗'}`
  );
  if (checkOnly) continue;
  if (!usdcOk) {
    const tx = await usdc.approve(spender, constants.MaxUint256);
    await tx.wait();
    console.log(`  → approved USDC for ${name} (${tx.hash})`);
  }
  if (!approved) {
    const tx = await ctf.setApprovalForAll(spender, true);
    await tx.wait();
    console.log(`  → approved CTF for ${name} (${tx.hash})`);
  }
}

console.log(
  checkOnly
    ? 'Check complete (no transactions sent).'
    : 'Setup complete. Set TRADING_ENABLED=true (and keep TRADING_DRY_RUN=true to shadow first).'
);
