# Going live: the trading runbook

Everything required to take the bot from "code exists" to "real orders on
Polymarket", in order. The paper record is the evidence; live trading just
executes it — **if the paper equity curve isn't convincingly positive, stop
here, there is nothing worth funding.**

The four stages:

| Stage | State | What's at risk |
| --- | --- | --- |
| 0. Paper | `TRADING_ENABLED=false` (default) | nothing |
| 1. Setup | wallet funded, allowances set | gas pennies |
| 2. Shadow | `TRADING_ENABLED=true`, `TRADING_DRY_RUN=true` | nothing |
| 3. Live | `TRADING_DRY_RUN=false` | real USDC |

---

## 0. Before anything: eligibility

Polymarket's terms prohibit trading from the US and several other
jurisdictions, and the CLOB geo-blocks restricted regions. Using the API does
not exempt an account from those terms. Confirm you can lawfully trade on
Polymarket from where the bot will run **before** funding anything. This is
your responsibility, not the bot's.

**Trading from the US? Use Kalshi instead.** Kalshi is a CFTC-regulated
exchange running the same style of crypto up/down markets and is legal for US
residents. Set `TRADING_PLATFORM=kalshi` and the whole stack — quotes,
strikes, fees, execution, settlement — switches over. Differences that
matter:

- **Only the 15m family has a live market** (`KXBTC15M` etc., all six
  assets). There is no 5m/4h equivalent, and Kalshi's hourly/daily series are
  fixed-strike ladders, not up/down. `TRADE_FAMILIES` defaults to `15m` on
  Kalshi. The other families keep predicting and building paper history —
  they just have nothing to quote or trade.
- **Section 1's wallet steps are replaced by an API key.** No wallet, no
  allowances, no gas, no `trade:setup`: fund your Kalshi account on the
  website, create an API key (account → API keys), and set
  `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY` (or `KALSHI_PRIVATE_KEY_PATH`)
  in `.env`. Dry-run needs no credentials at all.
- **Settlement is automatic.** Winning contracts pay $1 cash; there is no
  redemption step, so `TRADE_AUTO_REDEEM` and `trade:redeem` are inert.
- **Fees are cheaper and shaped differently**: 7% · p · (1−p) per contract,
  charged in cash (≈1.75¢ on a 50¢ contract) vs Polymarket's 10% taken in
  shares. The paper layer and executor model this automatically
  (`PAPER_FEE_MODEL=quadratic`, `PAPER_TAKER_FEE_BPS=700` by default).
- **Markets resolve on CF Benchmarks' real-time index**, and the exact strike
  is published on the market record (`floor_strike`), so the strike-proxy
  caveat mostly disappears.
- The backfill/backtest scripts and `trade:verify` remain Polymarket-only; on
  Kalshi the paper record accumulates from live commits.

Shadow-mode evidence gathered on one platform does **not** carry to the
other: different family, different book depth, different fees. Restart the
shadow-mode clock after switching.

Also decide where the process will live. The executor only fires inside the
first 20% of each window (`COMMIT_BY_FRACTION`) — for the 5m family that is a
~60-second span every 5 minutes — so the server must run continuously
(a VPS, a home server, anything that doesn't sleep). A laptop that closes its
lid will simply miss windows; nothing breaks, but nothing trades either.

---

## 1. Wallet + funding

### Create a dedicated wallet

Never use a wallet that holds anything else. Generate a fresh one:

```bash
bun -e "import {Wallet} from 'ethers'; const w = Wallet.createRandom(); console.log('address:', w.address); console.log('key:    ', w.privateKey)"
```

- Put the key in `.env` as `POLYMARKET_PRIVATE_KEY`.
- Store a copy of the key somewhere safe **offline**. Anyone with this key
  has the money; treat `.env` accordingly (it is gitignored — keep it that
  way, and don't paste the key into chats, issues, or logs).

This is **signature type 0 (EOA)** — funds sit directly in the wallet and
orders are signed locally. Leave `POLYMARKET_SIGNATURE_TYPE=0` and
`POLYMARKET_FUNDER` empty. (Types 1/2 — trading through an existing
Polymarket web account's proxy wallet — work for order placement, but
auto-redeem is EOA-only and allowances must be managed via the UI. For an
unattended bot, the dedicated EOA is the right shape.)

### Fund it (on Polygon)

Two assets, both on **Polygon PoS**:

| Asset | Contract | How much | Why |
| --- | --- | --- | --- |
| **USDC.e** (bridged USDC) | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | your bankroll — start small, e.g. $50–250 | the CLOB's collateral |
| **POL** | native | ~2–5 POL | gas for approvals + redemptions |

⚠ **The USDC.e / native-USDC trap.** Polygon has two USDCs. The CLOB's
collateral is **USDC.e** (bridged, `0x2791…`), *not* native USDC
(`0x3c49…`). Exchanges that "withdraw USDC to Polygon" increasingly send the
native one. If you end up with native USDC, swap it to USDC.e on any Polygon
DEX (Uniswap, Quickswap) — the pair is deep and ~1:1. `bun run trade:check`
prints the USDC.e balance specifically, so a $0.00 there after funding means
you're holding the wrong one.

Match funding to the configured caps: with the defaults
(`TRADE_BANKROLL_CAP_USD=250`, `TRADE_MAX_STAKE_USD=10`,
`PAPER_MAX_STAKE_FRACTION=0.05`) a typical stake is **$3–10 per trade**, so
$100–250 of USDC.e is plenty to start. Don't fund more than the bankroll cap
— the executor won't use it.

### Run setup

```bash
bun run trade:check    # read-only: balances, API key, allowance status
bun run trade:setup    # same + sends the missing approval transactions
```

Setup does three things, all idempotent:

1. prints POL + USDC.e balances (verify both are non-zero),
2. derives the CLOB **API credentials** from one wallet signature
   (no Polymarket account signup needed — the wallet *is* the account),
3. sets six **allowances** (USDC + outcome tokens, for the CTF Exchange,
   Neg-risk Exchange, and Neg-risk Adapter) so matched orders can settle.

Expected end state — every row shows two checks:

```
CTF Exchange: USDC ✓  CTF ✓
Neg-risk Exchange: USDC ✓  CTF ✓
Neg-risk Adapter: USDC ✓  CTF ✓
```

---

## 2. Shadow mode (dry-run)

In `.env`:

```bash
TRADING_ENABLED=true
TRADING_DRY_RUN=true     # already the default — just don't set it false yet
```

Restart the server. From now on every committed call with a BET verdict runs
the **full execution path** — token resolution, live order book, edge
re-validation, Kelly sizing, every rail — and records a simulated fill at the
live ask to `data/trades.json`. Nothing is sent to the CLOB.

### Exit criteria — when is step 4 justified?

Let shadow mode run until **all** of these hold (typically 2–4 days for the
5m family):

1. **Volume:** ≥ 50 settled shadow trades. Fewer is noise.
2. **Profitability:** positive total `pnlUsd` over the period, and ROI on
   turnover (`pnlUsd / costUsd`) in the same ballpark as the paper replay's
   per-family ROI for the same span (`/api/paper`). The shadow record fills
   at the *ask of the side token at execution time* — slightly more honest
   than the paper replay's commit-time book — so some degradation is normal.
   A sign flip is not.
3. **Mechanics are clean:** no repeated `market tokens unavailable` /
   `no ask on side token` skips, no crashes in the `[trade]` log lines.
4. **The rails fired sensibly:** look at the skip log — `edge gone at
   execution` and `slippage cap` skips are the system working, not failing.
   If *most* attempts skip on slippage, the commit-time edge isn't surviving
   the book; widen nothing, fund nothing, investigate instead.

Check the scoreboard at any time:

```bash
curl -s localhost:8333/api/trades | bun -e "
const r = await new Response(Bun.stdin.stream()).json();
console.log(r.summary);
const s = r.trades.filter(t => t.settledAt);
console.log('ROI on turnover:', r.summary.costUsd ? (r.summary.pnlUsd / r.summary.costUsd).toFixed(3) : 'n/a');
console.log('win rate:', s.length ? (s.filter(t => t.won).length / s.length).toFixed(3) : 'n/a', 'of', s.length);
"
```

### Reset before going live

The shadow record and the live record share `data/trades.json`. Archive the
shadow run so the live P&L starts clean (the daily-loss rail also reads this
file — settled dry-run losses from today would count against the live limit):

```bash
mv data/trades.json data/trades.shadow-$(date +%Y%m%d).json
```

---

## 3. Step 4 — go live

The flip, in `.env`:

```bash
TRADING_DRY_RUN=false
```

Restart the server. That's the only change — same policy, same rails, real
orders. Start with the conservative defaults; **change one knob at a time and
only after the live record supports it**:

| Knob | Default | Raise when… |
| --- | --- | --- |
| `TRADE_FAMILIES` | `5m` | another family shows real (not just paper) edge |
| `TRADE_MAX_STAKE_USD` | `10` | ≥ 100 live trades at the current cap stayed profitable |
| `TRADE_BANKROLL_CAP_USD` | `250` | same |
| `TRADE_DAILY_LOSS_LIMIT_USD` | `25` | you've decided that's truly the daily pain you accept |
| `TRADE_MAX_SLIPPAGE` | `0.01` | never raise this to "fix" skipped trades — that's the rail doing its job |

### The first live hour, watch for:

- a `[trade] FILLED …` log line (or `PARTIAL` — fine, FAK keeps what filled),
- the fill price in `/api/trades` (`avgPrice`) vs the quote (`quotedCost`) —
  they should be within a tick,
- after the window resolves: a `[trade] settled …` line, then within the next
  resolve cycles a `[trade] redeemed …` line with a tx hash, and the USDC.e
  balance coming back up (`bun run trade:check`).

If fills are systematically worse than quotes or `unfilled` dominates, the
book is thinner than the shadow assumed — drop back to dry-run and reassess.

---

## 4. Operating it

### Routine monitoring

- `GET /api/trades` — the whole story: per-trade fills, P&L, `pnlTodayUsd`,
  and `halted` (true ⇒ the daily-loss kill switch is engaged until UTC
  midnight).
- `[trade]` lines in the server log — every fill, settle, redeem, and the
  *reason* for every skip.
- `bun run trade:check` weekly — POL doesn't get spent fast, but redemptions
  stop (with warnings in the log) if gas runs dry.

### Kill switches, fastest first

1. `TRADING_ENABLED=false` in `.env` + restart — trading layer fully inert.
2. Stop the server — open positions still resolve on-chain by themselves;
   claim later with `bun run trade:redeem`.
3. Drain the wallet — send USDC.e elsewhere; the executor then skips on
   `stake below min`.

### Facts worth knowing

- **Restarts are safe.** One trade max per window is persisted in
  `data/trades.json`; a restart can never double-fire a window, and a window
  whose commit span passed while the server was down is skipped.
- **The halt is daily and automatic.** Realized loss ≤
  −`TRADE_DAILY_LOSS_LIMIT_USD` stops new trades until UTC midnight. It does
  not close open positions (they're binary and expire in minutes anyway).
- **Redemption is the cash-back loop.** Wins pay in outcome tokens;
  `trade/redeem.ts` converts them to USDC.e each resolve cycle (needs POL).
  After downtime: `bun run trade:redeem`.
- **`data/trades.json` is the audit trail.** Back it up like the ledger; if
  you ever reconcile against the chain, `orderId`, `redeemTx`, and the wallet
  address on Polygonscan are everything you need.

### Troubleshooting

| Symptom | Likely cause → fix |
| --- | --- |
| `balance unavailable` skips | CLOB creds/connectivity — run `bun run trade:check`; if the API key derivation fails there too, the CLOB is down or the region is geo-blocked |
| USDC.e shows 0 after funding | you hold native USDC — swap to USDC.e (see §1) |
| `not enough balance / allowance` order errors | allowances missing → `bun run trade:setup`; or balance actually spent — check open positions |
| Redeem warnings every cycle | no POL for gas, or RPC down → fund POL / set `POLYGON_RPC_URL` to another endpoint |
| Everything skips `edge gone at execution` | book reprices against you between commit and execution — the model's edge may not be executable; stay in shadow |
| `halted: true` in `/api/trades` | daily loss limit hit — by design; resets at UTC midnight |
