import { cached, env } from '../cache.ts';
import {
  fetch24hChangePct,
  fetchCandleAt,
  fetchCandles,
  fetchPrice,
  TRADING_SYMBOL,
} from '../sources/binance.ts';
import { buildModel, predictAbove, predictPrice } from '../model/forecast.ts';
import { applyBias, assist } from '../model/llmAssist.ts';
import { recordPredictions } from '../model/ledger.ts';
import { recordInsight } from '../model/insights.ts';
import {
  fetchMarket,
  fetchPolymarketStrike,
  slugFor,
} from '../sources/polymarket.ts';
import type {
  Prediction,
  PricePoint,
  RangeId,
  RangePrediction,
  ServerSpotRangeId,
} from '../../shared/types.ts';

const TTL = Number(env('CACHE_TTL_PREDICT', '20'));
const ET = 'America/New_York';

/** Open price of the candle whose openTime is exactly `startMs`, if present. */
function candleOpenAt(
  candles: { openTime: number; open: number }[],
  startMs: number
): number | undefined {
  return candles.find(c => c.openTime === startMs)?.open;
}

/**
 * Close of the most recent candle that opened strictly before `startMs` — i.e.
 * the last observed price before the boundary, which is ~equal to the boundary
 * open and far more stable than live spot once the window has begun.
 */
function lastCloseBefore(
  candles: { openTime: number; close: number }[],
  startMs: number
): number | undefined {
  let best: { openTime: number; close: number } | undefined;
  for (const c of candles) {
    if (c.openTime < startMs && (!best || c.openTime > best.openTime)) best = c;
  }
  return best?.close;
}

type Candleish = { openTime: number; open: number; close: number };

/**
 * The "price to beat" at `startMs`: the candle open at that exact boundary,
 * preferring the coarsest candle given, then the finer one.
 *
 * Right after a boundary the new candle may not be cached yet (klines are
 * cached for a few seconds and were last fetched before the boundary). In that
 * gap we must NOT use live spot — spot has already drifted seconds into the new
 * window, so it skews the strike specifically at interval starts and snaps once
 * the real candle lands. Instead fall back to the close of the last candle
 * before the boundary (≈ the true open). Live spot is only a last resort.
 */
function strikeAt(
  startMs: number,
  coarse: Candleish[],
  fine: Candleish[],
  spot: number
): number {
  return (
    candleOpenAt(coarse, startMs) ??
    candleOpenAt(fine, startMs) ??
    lastCloseBefore(fine, startMs) ??
    lastCloseBefore(coarse, startMs) ??
    spot
  );
}

/** ET wall-clock offset (local - UTC) in ms at a given instant. */
function etOffsetMs(utcMs: number): number {
  const d = new Date(utcMs);
  const loc = new Date(d.toLocaleString('en-US', { timeZone: ET }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return loc.getTime() - utc.getTime();
}

/** UTC instant for 12:00 ET on the ET calendar date containing `refMs`. */
function noonEtUtc(refMs: number): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(refMs))
    .split('-')
    .map(Number);
  const wallAsUtc = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  return wallAsUtc - etOffsetMs(wallAsUtc);
}

const floorTo = (n: number, step: number) => Math.floor(n / step) * step;
const MS = { '5m': 5 * 60_000, '15m': 15 * 60_000, '1h': 60 * 60_000 };

/** Window bounds (start/end epoch ms) for each market family at `now`. */
function windowsAt(now: number) {
  const todayNoon = noonEtUtc(now);
  // The active daily market is the one whose closing noon is still ahead.
  const dayEnd =
    now >= todayNoon ? noonEtUtc(todayNoon + 30 * 3_600_000) : todayNoon;
  const dayStart =
    now >= todayNoon ? todayNoon : noonEtUtc(todayNoon - 18 * 3_600_000);
  return {
    '5m': {
      start: floorTo(now, MS['5m']),
      end: floorTo(now, MS['5m']) + MS['5m'],
    },
    '15m': {
      start: floorTo(now, MS['15m']),
      end: floorTo(now, MS['15m']) + MS['15m'],
    },
    '1h': {
      start: floorTo(now, MS['1h']),
      end: floorTo(now, MS['1h']) + MS['1h'],
    },
    '1d': { start: dayStart, end: dayEnd },
  } as Record<RangeId, { start: number; end: number }>;
}

const META: Record<
  RangeId,
  { label: string; resolutionSource: 'chainlink' | 'binance' }
> = {
  '5m': { label: '5 min', resolutionSource: 'chainlink' },
  '15m': { label: '15 min', resolutionSource: 'chainlink' },
  '1h': { label: 'Hourly', resolutionSource: 'binance' },
  '1d': { label: 'Daily', resolutionSource: 'binance' },
};

export async function predict(): Promise<Prediction> {
  return cached('predict:ranges', TTL, async () => {
    const now = Date.now();
    const win = windowsAt(now);

    // Fetch market data plus the EXACT boundary candle for each window, so the
    // strike is the precise Binance price at the boundary rather than whatever
    // is cached / live spot. open5m etc. are the 1m candle that opens at each
    // window start; openDay is the 1m candle at the prior noon ET.
    const [
      price,
      change24hPct,
      minuteCandles,
      fiveMinCandles,
      hourCandles,
      open5m,
      open15m,
      open1h,
      openDay,
      pmStrike5m,
      pmStrike15m,
    ] = await Promise.all([
      fetchPrice(),
      fetch24hChangePct(),
      fetchCandles('1m', 240),
      fetchCandles('5m', 80),
      fetchCandles('1h', 720),
      fetchCandleAt('1m', win['5m'].start),
      fetchCandleAt('1m', win['15m'].start),
      fetchCandleAt('1m', win['1h'].start),
      fetchCandleAt('1m', win['1d'].start),
      // Polymarket's exact Chainlink-derived "price to beat" for 5m/15m.
      fetchPolymarketStrike('5m', win['5m'].start, win['5m'].end).catch(
        () => undefined
      ),
      fetchPolymarketStrike('15m', win['15m'].start, win['15m'].end).catch(
        () => undefined
      ),
    ]);

    const model = buildModel({
      price,
      change24hPct,
      minuteCandles,
      hourCandles,
    });
    const a = await assist(model);

    // Strike (price to beat) per family, anchored to how each market settles:
    //  5m/15m → Chainlink BTC/USD. We read Polymarket's EXACT openPrice from
    //           their crypto-price API; only if it's unavailable do we fall
    //           back to the Binance 1m-open proxy (which carries a basis error).
    //  1h     → Binance BTC/USDT 1h candle OPEN = exact (1m open at boundary).
    //  1d     → Binance BTC/USDT 1m candle CLOSE at the prior noon ET = exact.
    const strikeByRange: Record<RangeId, number> = {
      '5m':
        pmStrike5m ??
        open5m?.open ??
        strikeAt(win['5m'].start, fiveMinCandles, minuteCandles, price),
      '15m':
        pmStrike15m ??
        open15m?.open ??
        strikeAt(win['15m'].start, fiveMinCandles, minuteCandles, price),
      '1h':
        open1h?.open ??
        candleOpenAt(hourCandles, win['1h'].start) ??
        lastCloseBefore(hourCandles, win['1h'].start) ??
        price,
      '1d':
        openDay?.close ??
        candleOpenAt(hourCandles, win['1d'].start) ??
        lastCloseBefore(hourCandles, win['1d'].start) ??
        price,
    };

    // 5m/15m strikes are only a "proxy" when we couldn't get Polymarket's exact
    // openPrice and fell back to the Binance boundary candle. 1h/1d are always
    // exact Binance settlement prices.
    const strikeIsProxyByRange: Record<RangeId, boolean> = {
      '5m': pmStrike5m === undefined,
      '15m': pmStrike15m === undefined,
      '1h': false,
      '1d': false,
    };

    const order: RangeId[] = ['5m', '15m', '1h', '1d'];

    const markets = await Promise.all(
      order.map(id => {
        const w = win[id];
        const slug = id === '1d' ? slugFor['1d'](w.end) : slugFor[id](w.start);
        return fetchMarket(slug, w.start, w.end).catch(() => null);
      })
    );

    const ranges: RangePrediction[] = order.map((id, i) => {
      const w = win[id];
      const strike = strikeByRange[id];
      // Precise (possibly sub-minute) horizon: rounding to whole minutes near a
      // boundary overstates remaining variance and drags near-certain outcomes
      // back toward 50/50. Floor at 1 second to avoid a zero-vol singularity.
      const remaining = Math.max(1 / 60, (w.end - now) / 60_000);
      const endIso = new Date(w.end).toISOString();
      const probUp = applyBias(
        predictAbove(model, strike, remaining, endIso).probAbove,
        a.bias,
        remaining
      );
      return {
        id,
        label: META[id].label,
        resolutionSource: META[id].resolutionSource,
        strikeIsProxy: strikeIsProxyByRange[id],
        horizonMinutes: remaining,
        probUp,
        probDown: 1 - probUp,
        strike,
        windowStart: new Date(w.start).toISOString(),
        windowEnd: endIso,
        forecast: predictPrice(model, remaining, endIso, strike),
        market: markets[i] ?? undefined,
      };
    });

    // Recent price history for client sparklines: last ~120 1m closes, with the
    // live spot appended so charts end at the current price.
    const history = minuteCandles
      .slice(-120)
      .map(c => ({ t: c.openTime, price: c.close }));
    history.push({ t: now, price });

    // Spot chart series at several look-back windows. Each picks the coarsest
    // candle that still gives enough resolution for that span, with live spot
    // appended so every series ends at the current price.
    const toPts = (cs: { openTime: number; close: number }[]) =>
      cs.map(c => ({ t: c.openTime, price: c.close }));
    const spot: Record<ServerSpotRangeId, PricePoint[]> = {
      '1H': toPts(minuteCandles.slice(-60)),
      '6H': toPts(fiveMinCandles.slice(-72)),
      '1D': toPts(hourCandles.slice(-24)),
      '1W': toPts(hourCandles.slice(-168)),
    };
    for (const key of Object.keys(spot) as ServerSpotRangeId[]) {
      spot[key].push({ t: now, price });
    }

    const prediction: Prediction = {
      asOf: new Date(now).toISOString(),
      symbol: TRADING_SYMBOL,
      stats: model.stats,
      ranges,
      narrative: a.narrative,
      reasoning: a.reasoning,
      llmApplied: a.llmApplied,
      history,
      spot,
    };

    // Capture this fresh read into the windowed in-memory insights log (runs
    // inside the fetcher, so only on a real recompute — not on cache hits).
    recordInsight(prediction);

    // Record our calls for the open windows (fire-and-forget; never block the
    // response or fail the request on a logging error).
    void recordPredictions(prediction).catch(err =>
      console.warn('[ledger] record failed:', err)
    );

    return prediction;
  });
}
