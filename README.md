# Bitcoin Predict

A small Bun + TypeScript app that predicts near-term Bitcoin moves and renders
them on a live dashboard. It reads BTC/USDT directly from the Binance public API
(the same source the related Polymarket markets resolve against) and produces
four predictions:

1. **Up / Down — 5 min** — directional probability for the next 5 minutes
2. **Up / Down — 15 min** — same, 15-minute horizon
3. **Above strike** — probability BTC closes above a strike at a target time
4. **Price forecast** — a point estimate + ~95% confidence band

An optional LLM-assist layer adds a short read and a small (clamped) nudge to the
directional probabilities. With no API key the app runs a transparent, pure
statistical model.

## Quick start

```bash
bun install
cp .env.example .env   # optional — runs fine with no keys
bun run dev
```

Open **http://localhost:8333** (Bitcoin's default P2P port). The dashboard
auto-refreshes every 5 seconds.
Type a **strike** and **target time** to drive the "above" and price-forecast
cards (defaults: spot price, ~next noon).

## How the model works

Log-returns between consecutive Binance candles are treated as i.i.d. normal with
a small drift `μ` and volatility `σ` estimated from recent history. Over a horizon
of `h` periods the cumulative log-return is `~ Normal(μ·h, σ²·h)`, giving:

- **direction:** `P(up) = Φ(μ·h / (σ·√h))`
- **above strike `K`:** `P(>K) = 1 − Φ((ln(K/price) − μ·h) / (σ·√h))`
- **price point:** `price · exp(μ·h)`, with a lognormal 95% band

Short horizons (5m/15m) use per-minute stats from 1m candles; longer horizons use
per-hour stats from 1h candles. See `src/server/model/forecast.ts`.

> Near-term price moves are close to a coin flip, so directional probabilities
> stay near 50% by design. This is a toy forecaster, not trading advice.

## Optional LLM-assist

Set `LLM_MODEL` plus the matching API key in `.env` to enable an LLM read. Models
are registered in `src/server/ai/providers.ts` (OpenAI, Anthropic, or a local
LMStudio server). Without a key, the app uses a stats-only narrative. The LLM can
only nudge directional probabilities by ±8%, clamped — it never overrides the
statistical core.

## Architecture

```
client (browser)
  └─ dashboard: live price + tabs per Polymarket market (5m/15m/hourly/daily),
     polls /api/predict every 5s

server (Bun)
  ├─ sources/binance.ts   → spot price, 24h change, OHLC 1m + 1h klines (cached)
  ├─ model/forecast.ts    → lognormal model (EWMA+Garman-Klass vol, shrunk drift)
  ├─ model/scoring.ts     → Brier / log-loss / reliability (for the backtest)
  ├─ model/llmAssist.ts   → optional LLM read + horizon-scaled bias
  └─ routes/predict.ts    → GET /api/predict → Prediction JSON
```

## Model

Log-returns are treated as ~Normal over the remaining horizon. Two
accuracy-oriented choices, both validated by the backtest:

- **Volatility** is an EWMA of the **Garman-Klass** range estimator (uses
  O/H/L/C), which is far more efficient and regime-aware than equal-weighted
  close-to-close variance.
- **Drift is off by default** (`MODEL_DRIFT_SHRINK=0`). Trailing drift is mostly
  noise and, extrapolated over the horizon, biases direction; backtesting shows
  a driftless random walk scores best. A shrink fraction and a
  diffusion-relative cap (`MODEL_DRIFT_CAP_SIGMAS`) are available to re-enable
  and tune it.

Tunables (env): `MODEL_EWMA_LAMBDA` (default `0.94`), `MODEL_DRIFT_SHRINK`
(`0`), `MODEL_DRIFT_CAP_SIGMAS` (`0.5`).

### Backtesting

`bun run backtest` walk-forward tests the direction model on historical Binance
klines, sampling decision points inside each 5m/15m window, and scores it
against the original (full-drift, close-to-close) model and a 0.5 baseline with
Brier, log-loss, and a calibration curve. Sweep config inline, e.g.:

```bash
bun run backtest -- --days 5
MODEL_DRIFT_SHRINK=1 bun run backtest -- --days 5   # compare with full drift
```

## API

```
GET /api/predict
```

Returns the full `Prediction` object (see `src/shared/types.ts`). It computes
one `RangePrediction` per Polymarket BTC Up/Down family — `5m`, `15m`, `1h`
(hourly), and `1d` (daily) — each with the window-anchored up/down odds, the
price-to-beat, a price forecast for the window close, and the live Polymarket
quote when one exists. No query params.

## Development

```bash
bun run dev         # hot-reload server (client rebuilt + live-reloaded)
bun run backtest    # walk-forward score the direction model
bun run typecheck   # TypeScript checks
bun run lint        # ESLint
bun run format      # Prettier
```
