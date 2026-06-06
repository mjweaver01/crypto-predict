import { cached, env } from '../cache.ts';
import {
  fetch24hChangePct,
  fetchCandles,
  fetchPrice,
  TRADING_SYMBOL,
} from '../sources/binance.ts';
import {
  buildModel,
  predictAbove,
  predictDirection,
  predictPrice,
} from '../model/forecast.ts';
import { applyBias, assist } from '../model/llmAssist.ts';
import type { Prediction } from '../../shared/types.ts';

const TTL = Number(env('CACHE_TTL_PREDICT', '20'));

/**
 * Open price of the candle that starts at (or most recently before) `startMs`.
 * Binance 1m candles are minute-aligned, so a 5m-aligned start usually matches
 * a candle's openTime exactly; we fall back to the last candle at/under it.
 */
function intervalOpen(
  candles: { openTime: number; open: number }[],
  startMs: number
): number | undefined {
  let best: { openTime: number; open: number } | undefined;
  for (const c of candles) {
    if (c.openTime === startMs) return c.open;
    if (c.openTime < startMs && (!best || c.openTime > best.openTime)) best = c;
  }
  return best?.open;
}

export interface PredictParams {
  /** Strike for the "above price on date" market. Defaults to spot. */
  strike?: number;
  /** ISO target time for the strike + price forecast. Defaults to +24h. */
  target?: string;
}

export async function predict(params: PredictParams = {}): Promise<Prediction> {
  const strikeKey = params.strike ?? 'spot';
  const targetKey = params.target ?? '24h';

  return cached(`predict:${strikeKey}:${targetKey}`, TTL, async () => {
    const [price, change24hPct, minuteCandles, hourCandles] = await Promise.all([
      fetchPrice(),
      fetch24hChangePct(),
      fetchCandles('1m', 240),
      fetchCandles('1h', 720),
    ]);

    const model = buildModel({ price, change24hPct, minuteCandles, hourCandles });

    const now = Date.now();
    const target = params.target
      ? new Date(params.target)
      : new Date(now + 24 * 60 * 60 * 1000);
    const horizonMin = Math.max(1, Math.round((target.getTime() - now) / 60_000));

    // Polymarket 5m markets resolve against the "price to beat": the price at
    // the open of the interval [target-5m, target]. Default the strike to that
    // so projections answer the same question the market does.
    const intervalStart = target.getTime() - 5 * 60_000;
    const priceToBeat = intervalOpen(minuteCandles, intervalStart) ?? price;
    const strike = params.strike ?? priceToBeat;

    const a = await assist(model);

    const up5mRaw = predictDirection(model, 5);
    const up15mRaw = predictDirection(model, 15);
    const up5mProb = applyBias(up5mRaw.probUp, a.bias);
    const up15mProb = applyBias(up15mRaw.probUp, a.bias);

    return {
      asOf: new Date(now).toISOString(),
      symbol: TRADING_SYMBOL,
      stats: model.stats,
      up5m: { horizonMinutes: 5, probUp: up5mProb, probDown: 1 - up5mProb },
      up15m: { horizonMinutes: 15, probUp: up15mProb, probDown: 1 - up15mProb },
      above: predictAbove(model, strike, horizonMin, target.toISOString()),
      price: predictPrice(model, horizonMin, target.toISOString()),
      narrative: a.narrative,
      reasoning: a.reasoning,
      llmApplied: a.llmApplied,
    };
  });
}
