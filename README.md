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
  └─ single dashboard: live price + 4 prediction cards, polls /api/predict every 5s

server (Bun)
  ├─ sources/binance.ts   → spot price, 24h change, 1m + 1h klines (cached)
  ├─ model/forecast.ts    → lognormal drift/vol model → 4 predictions
  ├─ model/llmAssist.ts   → optional LLM read + clamped bias
  └─ routes/predict.ts    → GET /api/predict?strike=&target= → Prediction JSON
```

## API

```
GET /api/predict?strike=65000&target=2026-06-06T16:00:00.000Z
```

Returns the full `Prediction` object (see `src/shared/types.ts`). Both query
params are optional (`strike` defaults to spot, `target` to +24h).

## Development

```bash
bun run dev         # hot-reload server (client rebuilt + live-reloaded)
bun run typecheck   # TypeScript checks
bun run lint        # ESLint
bun run format      # Prettier
```
