# Bitcoin Predict

A self-calibrating forecasting engine for near-term Bitcoin direction, rendered
on a live dashboard. It reads BTC/USDT from the Binance public API — the same
data the mirrored Polymarket markets settle against — and produces a probability
of **Up** vs **Down** for each market family, a price-to-beat, and a price
forecast with a confidence band.

What sets it apart from a one-shot predictor is the **learning loop**: every call
is committed early, frozen, graded against the real market outcome, and fed back
into a calibration layer that continuously corrects the model's confidence and
bias. The system measurably improves as it accumulates outcomes.

It mirrors four recurring Polymarket families:

| Family | Horizon | Settles on |
| --- | --- | --- |
| **5 min** | rolling 5-minute window | Chainlink BTC/USD |
| **15 min** | rolling 15-minute window | Chainlink BTC/USD |
| **Hourly** | top-of-hour window | Binance BTC/USDT 1h candle |
| **Daily** | noon-ET to noon-ET | Binance BTC/USDT 1m close at noon ET |

An optional LLM-assist layer adds a short narrative and a small, clamped
directional nudge. With no API key the app runs a fully transparent statistical
model.

## Quick start

```bash
bun install
cp .env.example .env   # optional — runs fine with no keys
bun run dev
```

Open **http://localhost:8333** (Bitcoin's default P2P port). The dashboard
auto-refreshes every 5 seconds.

To seed the learning loop with history so calibration is active immediately:

```bash
bun run backfill       # reconstructs ~288 historical committed calls vs outcomes
```

---

## The learning loop

The core design separates three concerns that a naive forecaster conflates, then
closes the loop between prediction and outcome.

```
            ┌─────────────────────────────────────────────────────────────┐
            │                                                               │
   market   │   1. Statistical model ──► 2. LLM nudge ──► raw probability   │
   data ───►│            │                                       │          │
            │            │                          3. Calibration (learned)│
            │            │                                       │          │
            │            ▼                                       ▼          │
            │   4. Commit a frozen call ◄───────────── calibrated probability
            │            │                                                  │
            │            ▼                                                  │
            │   5. Window resolves ──► grade vs real outcome ──► ledger      │
            │                                       │                       │
            └───────────────────────────────────────┼──────────────────────┘
                                                     │
                          6. Refit calibrators ◄─────┘   (every resolve cycle)
```

### 1. Statistical core

Log-returns between consecutive Binance candles are modeled as approximately
normal with a small drift `μ` and volatility `σ`. Over a horizon of `h` periods
the cumulative log-return is `~ Normal(μ·h, σ²·h)`, giving:

- **direction / above strike `K`:** `P(close > K) = 1 − Φ((ln(K/price) − μ·h) / (σ·√h))`
- **price point:** `price · exp(μ·h)`, with a lognormal 95% band

Two accuracy-oriented refinements, both validated by the backtest:

- **Volatility** is an EWMA of the **Garman-Klass** range estimator (uses
  O/H/L/C), far more efficient and regime-aware than close-to-close variance.
- **Drift is off by default** (`MODEL_DRIFT_SHRINK=0`). Trailing drift is mostly
  noise and biases direction when extrapolated; a driftless random walk scores
  best. A shrink fraction and a diffusion-relative cap remain available to tune.

Short horizons (5m/15m) use per-minute stats from 1m candles; longer horizons use
per-hour stats from 1h candles. See `src/server/model/forecast.ts`.

### 2. LLM-assist (optional)

A configured model returns a terse directional read and a bias in `[-1, 1]`. The
bias can shift the up-probability by at most **±8%**, decaying with horizon, and
is clamped — it never overrides the statistical core. Falls back to a stats-only
narrative with no key. See `src/server/model/llmAssist.ts`.

### 3. Committed calls vs. the live read

A pure snapshot predictor has a UX and a scientific problem: as a window
approaches expiry the probability of "close above the open" *correctly* collapses
toward 0 or 1 (it's the delta of a binary option). The number appears to "flip,"
and grading the last pre-close snapshot peeks at where price already landed —
inflating apparent accuracy and yielding a bet you could never actually place.

The engine therefore distinguishes two quantities:

- **Committed call** — a single directional bet locked in *early* (while the
  horizon is still long), then **frozen** until the window resolves. This is the
  wager we grade and learn from. See `src/server/model/commitments.ts`.
- **Live read** — the probability recomputed each tick, free to converge toward
  the outcome. Shown as a "where it stands now" gauge, clearly labeled.

Commitment timing is governed by `COMMIT_BY_FRACTION` (default `0.2`): a call is
locked in only if the window is first observed within the first 20% of its life,
which in practice is the first refresh after the window opens. Windows first seen
too late to make a genuine forward-looking call are not graded. Open commitments
are hydrated from the ledger on startup, so a restart mid-window keeps its call.

### 4. Self-calibration

This is what makes the model **get better as it sees more outcomes**. For each
family we fit a mapping from the model's raw probability to the empirically
observed win frequency, using resolved committed calls — **Platt scaling in logit
space**:

```
calibrated_logit = a · raw_logit + b
```

- `a < 1` shrinks overconfident probabilities toward 0.5.
- `b` corrects a systematic directional / base-rate bias.

The fit is a **regularized (ridge) logistic regression** whose L2 prior pulls
`(a, b)` toward the identity `(1, 0)`. With little data it stays ≈ identity, and
below a minimum sample count it is a strict no-op — so calibration can only help
once real evidence accumulates and never distorts a thin sample. Each family is
calibrated independently.

A deliberate invariant keeps the loop stable: we always store and fit on the
**raw** probability, never the already-calibrated output. This keeps the training
signal stationary as the calibrator evolves — otherwise it would compound its own
corrections. See `src/server/model/calibration.ts`.

### 5–6. Resolution and refit

A background loop resolves matured windows against the **real Polymarket
outcome** (Binance close as a fallback), then refits every family's calibrator
from the updated track record — so each freshly settled call immediately
sharpens the next prediction. Calibration status (sample count and the
adjustment applied) is surfaced per family on the dashboard.

---

## Seeding the loop: backfill

Calibration needs resolved outcomes, which would otherwise take days to
accumulate (the 1h/1d families especially). `bun run backfill` jump-starts it by
reconstructing historical **committed calls**: for each recent resolved 5m/15m/1h
window it rebuilds the model's raw probability *early* in the window — exactly
mirroring the live commit timing and using only the candles available at that
instant — and pairs it with the real Polymarket outcome.

The backfill reconstructs short-horizon families from minute candles and
long-horizon families from real hourly candles, so the reconstruction matches the
statistics the live model would have used, with no look-ahead. Backfilled rows
carry the raw probability, so the calibrators pick them up on the next refit.

> Backfilled rows reflect the pure statistical model (the small LLM nudge cannot
> be replayed historically), so treat them as a strong prior, not ground truth.

---

## Track record (ledger)

Every committed call is logged to `data/ledger.json` with its window, strike,
side, confidence, and both the calibrated and raw probabilities. Once the window
closes it is resolved against the real market outcome and scored (Brier / hit
rate, per family).

```
GET /api/ledger    → { summary, entries }
GET /api/insights  → in-memory, windowed log of how the model's read evolved
```

---

## Strike (price to beat)

Each family's strike matches the venue it settles against, exactly:

| Family | Resolves on | Strike we use | Source |
| --- | --- | --- | --- |
| 5m / 15m | Chainlink BTC/USD | Polymarket `crypto-price` **openPrice** | exact¹ |
| Hourly | Binance BTC/USDT 1h candle | Binance 1h **open** | exact |
| Daily | Binance BTC/USDT 1m close @ noon ET | Binance 1m **close** at prior noon | exact |

¹ The 5m/15m markets settle on the **Chainlink** BTC/USD stream — a different
feed than Binance, so a Binance proxy is off by tens of dollars. We read the
exact Chainlink-derived open from Polymarket's API via `fetchPolymarketStrike`;
if that fails we fall back to the Binance 1m-open proxy and flag the strike as
approximate (`strikeIsProxy`).

---

## Backtesting

`bun run backtest` walk-forward tests the direction model on historical Binance
klines, sampling decision points inside each 5m/15m window, and scores it against
the original (full-drift, close-to-close) model and a 0.5 baseline with Brier,
log-loss, and a reliability curve.

```bash
bun run backtest -- --days 5
MODEL_DRIFT_SHRINK=1 bun run backtest -- --days 5   # compare with full drift
```

`bun run backtest:market` additionally scores the model against the **real
historical Polymarket odds** and every blend weight. Result: the standalone model
beats the market on 5m/15m and blending only hurts — so we do **not** ensemble;
the market quote is shown for edge, not folded into the model.

---

## Architecture

```
client (browser)
  └─ dashboard: live price + per-family tabs (5m/15m/hourly/daily); shows the
     committed call, the converging live read, and calibration status; polls
     /api/predict every 5s

server (Bun)
  ├─ sources/binance.ts    → spot, 24h change, OHLC klines + exact boundary candle
  ├─ sources/polymarket.ts → live odds + historical outcome/price + exact strike
  ├─ model/forecast.ts     → lognormal model (EWMA + Garman-Klass vol, shrunk drift)
  ├─ model/llmAssist.ts    → optional LLM read + horizon-scaled, clamped bias
  ├─ model/commitments.ts  → freezes one forward-looking call per window
  ├─ model/calibration.ts  → learned per-family Platt calibration (the feedback loop)
  ├─ model/ledger.ts       → committed calls vs real outcomes → data/ledger.json
  ├─ model/insights.ts     → windowed in-memory log of how the read evolved
  ├─ model/scoring.ts      → Brier / log-loss / reliability (backtest harness)
  └─ routes/predict.ts     → GET /api/predict → Prediction JSON
```

---

## Configuration (env)

| Variable | Default | Purpose |
| --- | --- | --- |
| `LLM_MODEL` + key | — | Enable the LLM-assist read (OpenAI / Anthropic / LMStudio) |
| `MODEL_EWMA_LAMBDA` | `0.94` | EWMA decay for volatility/drift |
| `MODEL_DRIFT_SHRINK` | `0` | Fraction of trailing drift retained (0 = driftless) |
| `MODEL_DRIFT_CAP_SIGMAS` | `0.5` | Cap on drift as a multiple of diffusion |
| `COMMIT_BY_FRACTION` | `0.2` | How early a window must be seen to commit a call |
| `CALIB_MIN_SAMPLES` | `25` | Resolved calls required before calibration activates |
| `CALIB_PRIOR` | `10` | Shrinkage strength toward the identity calibrator |

---

## Development

```bash
bun run dev         # hot-reload server (client rebuilt + live-reloaded)
bun run backfill    # seed the ledger + calibration with historical calls vs outcomes
bun run backtest    # walk-forward score the direction model
bun run typecheck   # TypeScript checks
bun run lint        # ESLint
bun run format      # Prettier
```

> Near-term BTC direction is close to a coin flip, so committed probabilities sit
> near 50% by design and calibration mainly corrects confidence and bias. This is
> a research/forecasting project, not trading advice.
