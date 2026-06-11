import { cached, env, invalidate } from '../cache.ts';
import {
  fetch24hChangePct,
  fetchCandleAt,
  fetchCandles,
  fetchPrice,
  TRADING_SYMBOL,
} from '../sources/binance.ts';
import {
  buildModel,
  predictAbove,
  predictPrice,
  sigmaPerMinFor,
} from '../model/forecast.ts';
import { extractFeatures } from '../model/features.ts';
import {
  applyBias,
  assist,
  statsAssist,
  type Assist,
} from '../model/llmAssist.ts';
import { getLedger, recordPredictions } from '../model/ledger.ts';
import { decide, ensureHydrated } from '../model/commitments.ts';
import { decideBet, simulatePaper } from '../model/paper.ts';
import {
  applyCalibration,
  calibrationInfo,
  getCalibrator,
} from '../model/calibration.ts';
import { recordInsight } from '../model/insights.ts';
import { dailyWindowAt } from '../model/windows.ts';
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

/**
 * The most recent prediction computed by the server-side commit loop. The
 * browser reads this snapshot instead of triggering a recompute, so ALL data
 * generation (committing calls, recording insights) happens on the server's own
 * cadence rather than as a side effect of an HTTP request.
 */
let latest: Prediction | null = null;

/**
 * The latest server-computed prediction, or null before the first cycle — or
 * when the snapshot straddles a window boundary (some window already closed).
 * Returning null in that case makes the API path recompute immediately, so the
 * dashboard shows the new window's wager as soon as the countdown hits zero
 * instead of waiting out the commit tick.
 */
export function getLatestPrediction(): Prediction | null {
  if (!latest) return null;
  const now = Date.now();
  const stale = latest.ranges.some(r => Date.parse(r.windowEnd) <= now);
  return stale ? null : latest;
}

/**
 * How long the regular tick waits for a fresh LLM read before serving the
 * previous one (stale-while-revalidate). Hosted APIs usually finish within
 * this; a slow local model keeps generating in the background and its read is
 * picked up on a later tick — the 20s commit cadence is never blocked.
 */
const ASSIST_FRESH_WAIT_MS = 2_000;
/** The manual refresh button is explicitly asking for a NEW read: wait for it. */
const ASSIST_REFRESH_WAIT_MS = 120_000;

/** Last completed LLM read, served while a newer generation is in flight. */
let lastAssist: Assist | null = null;

const delay = (ms: number) =>
  new Promise<null>(res => setTimeout(() => res(null), ms));

/**
 * Force a fresh LLM read on demand (the dashboard's refresh button): drop the
 * current 5m window's cached assist plus the prediction snapshot, recompute,
 * and WAIT for the new read (unlike the tick path, which serves the previous
 * read while regenerating). Committed calls are unaffected — they were frozen.
 */
export async function refreshRead(): Promise<Prediction> {
  invalidate(`assist:${floorTo(Date.now(), MS['5m'])}`);
  invalidate('predict:ranges');
  const p = await computePrediction(ASSIST_REFRESH_WAIT_MS);
  latest = p;
  return p;
}

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

const floorTo = (n: number, step: number) => Math.floor(n / step) * step;
const MS = {
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** Window bounds (start/end epoch ms) for each market family at `now`. */
function windowsAt(now: number) {
  const day = dailyWindowAt(now);
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
    // 4h windows sit on the epoch lattice (00/04/08/12/16/20 UTC), matching
    // Polymarket's btc-updown-4h-{startUnix} slugs.
    '4h': {
      start: floorTo(now, MS['4h']),
      end: floorTo(now, MS['4h']) + MS['4h'],
    },
    '1d': { start: day.start, end: day.end },
  } as Record<RangeId, { start: number; end: number }>;
}

const META: Record<
  RangeId,
  { label: string; resolutionSource: 'chainlink' | 'binance' }
> = {
  '5m': { label: '5 min', resolutionSource: 'chainlink' },
  '15m': { label: '15 min', resolutionSource: 'chainlink' },
  '1h': { label: 'Hourly', resolutionSource: 'binance' },
  '4h': { label: '4 hour', resolutionSource: 'chainlink' },
  '1d': { label: 'Daily', resolutionSource: 'binance' },
};

/** Ms until the next 5m boundary — the lattice every market window closes on
 * (15m/1h are multiples; the daily noon-ET close is on the hour). */
export function msToNextBoundary(now = Date.now()): number {
  return floorTo(now, MS['5m']) + MS['5m'] - now;
}

export async function predict(): Promise<Prediction> {
  // Never let a cached snapshot outlive a window boundary: clamp the TTL so the
  // entry expires the moment any market window closes and the next call
  // recomputes with the new window's strike + committed call.
  const ttl = Math.max(1, Math.min(TTL, Math.ceil(msToNextBoundary() / 1000)));
  const p = await cached('predict:ranges', ttl, () =>
    computePrediction(ASSIST_FRESH_WAIT_MS)
  );
  latest = p;
  return p;
}

async function computePrediction(assistWaitMs: number): Promise<Prediction> {
  {
    const now = Date.now();
    const win = windowsAt(now);

    // Load any still-open committed calls from the ledger before we decide, so
    // a restart mid-window keeps the call we already locked in.
    await ensureHydrated();

    // Current paper bankroll, so a live BET verdict can state its dollar stake
    // (the replay sizes open bets at this same running bankroll).
    let bankroll: number | undefined;
    try {
      bankroll = simulatePaper(await getLedger()).summary.bankroll;
    } catch (err) {
      console.warn('[paper] bankroll unavailable for live stake:', err);
    }

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
      open4h,
      openDay,
      pmStrike5m,
      pmStrike15m,
      pmStrike4h,
    ] = await Promise.all([
      fetchPrice(),
      fetch24hChangePct(),
      fetchCandles('1m', 240),
      fetchCandles('5m', 80),
      fetchCandles('1h', 720),
      fetchCandleAt('1m', win['5m'].start),
      fetchCandleAt('1m', win['15m'].start),
      fetchCandleAt('1m', win['1h'].start),
      fetchCandleAt('1m', win['4h'].start),
      fetchCandleAt('1m', win['1d'].start),
      // Polymarket's exact Chainlink-derived "price to beat" for 5m/15m/4h.
      fetchPolymarketStrike('5m', win['5m'].start, win['5m'].end).catch(
        () => undefined
      ),
      fetchPolymarketStrike('15m', win['15m'].start, win['15m'].end).catch(
        () => undefined
      ),
      fetchPolymarketStrike('4h', win['4h'].start, win['4h'].end).catch(
        () => undefined
      ),
    ]);

    const model = buildModel({
      price,
      change24hPct,
      minuteCandles,
      hourCandles,
    });

    // Strike (price to beat) per family, anchored to how each market settles:
    //  5m/15m/4h → Chainlink BTC/USD. We read Polymarket's EXACT openPrice from
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
      '4h':
        pmStrike4h ??
        open4h?.open ??
        candleOpenAt(hourCandles, win['4h'].start) ??
        lastCloseBefore(hourCandles, win['4h'].start) ??
        price,
      '1d':
        openDay?.close ??
        candleOpenAt(hourCandles, win['1d'].start) ??
        lastCloseBefore(hourCandles, win['1d'].start) ??
        price,
    };

    // Chainlink-family strikes are only a "proxy" when we couldn't get
    // Polymarket's exact openPrice and fell back to the Binance boundary
    // candle. 1h/1d are always exact Binance settlement prices.
    const strikeIsProxyByRange: Record<RangeId, boolean> = {
      '5m': pmStrike5m === undefined,
      '15m': pmStrike15m === undefined,
      '1h': false,
      '4h': pmStrike4h === undefined,
      '1d': false,
    };

    const order: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

    const markets = await Promise.all(
      order.map(id => {
        const w = win[id];
        const slug = id === '1d' ? slugFor['1d'](w.end) : slugFor[id](w.start);
        return fetchMarket(slug, w.start, w.end).catch(() => null);
      })
    );

    // Ground the LLM read in the model's own per-window calls (base P(up) before
    // bias, the price to beat, and market-implied odds) so the narrative cites
    // concrete levels instead of restating raw stats.
    const reads = order.map((id, i) => {
      const w = win[id];
      const remaining = Math.max(1 / 60, (w.end - now) / 60_000);
      const strike = strikeByRange[id];
      const probUp = predictAbove(
        model,
        strike,
        remaining,
        new Date(w.end).toISOString()
      ).probAbove;
      return {
        label: META[id].label,
        horizonMin: remaining,
        strike,
        probUp,
        marketImpliedUp: markets[i]?.impliedUp,
      };
    });
    // Refresh the LLM read once per 5m window — at the boundary where the 5m
    // commitment is placed — instead of on every 20s tick. The cache is
    // single-flight, so concurrent ticks join one generation rather than
    // stampeding the provider. Stale-while-revalidate: if the fresh read isn't
    // ready within `assistWaitMs`, serve the previous read and let the
    // generation finish in the background — the commit cadence never blocks on
    // a slow local model.
    const assistPromise = cached(`assist:${win['5m'].start}`, 360, () =>
      assist(model, { price, reads })
    );
    assistPromise.then(
      v => (lastAssist = v),
      () => {}
    );
    const a =
      (await Promise.race([assistPromise, delay(assistWaitMs)])) ??
      lastAssist ??
      statsAssist(model, { price, reads });

    const ranges: RangePrediction[] = order.map((id, i) => {
      const w = win[id];
      const strike = strikeByRange[id];
      // Precise (possibly sub-minute) horizon: rounding to whole minutes near a
      // boundary overstates remaining variance and drags near-certain outcomes
      // back toward 50/50. Floor at 1 second to avoid a zero-vol singularity.
      const remaining = Math.max(1 / 60, (w.end - now) / 60_000);
      const endIso = new Date(w.end).toISOString();
      // Raw model probability (statistical model + LLM bias), then the learned
      // layer fit from our resolved track record. probUp is what we show and
      // bet on; rawProbUp + features are preserved so the learner keeps
      // training on a stationary signal rather than its own corrected output.
      const rawProbUp = applyBias(
        predictAbove(model, strike, remaining, endIso).probAbove,
        a.bias,
        remaining
      );
      // Commit-time feature record for the learned layer (frozen onto the
      // committed call below, so training rows reflect decision-time inputs).
      const features = extractFeatures({
        family: id,
        price,
        strike,
        horizonMinutes: remaining,
        sigmaPerMin: sigmaPerMinFor(model, remaining),
        minuteCandles,
        hourCandles,
        marketImpliedUp: markets[i]?.impliedUp,
        now,
      });
      const probUp = applyCalibration(rawProbUp, features, getCalibrator(id));
      const range: RangePrediction = {
        id,
        label: META[id].label,
        resolutionSource: META[id].resolutionSource,
        strikeIsProxy: strikeIsProxyByRange[id],
        horizonMinutes: remaining,
        probUp,
        rawProbUp,
        features,
        probDown: 1 - probUp,
        strike,
        windowStart: new Date(w.start).toISOString(),
        windowEnd: endIso,
        forecast: predictPrice(model, remaining, endIso, strike),
        calibration: calibrationInfo(id),
        market: markets[i] ?? undefined,
      };
      // Lock in (or recall) the frozen directional call for this window. The
      // live probUp above keeps converging toward the outcome; `committed` is
      // the forward-looking bet we actually grade.
      range.committed = decide(range, now);
      // EV verdict on the frozen call at its frozen book — the same decision
      // the paper-trading replay makes, surfaced live.
      if (range.committed) {
        const c = range.committed;
        range.paper = decideBet(
          c.probUp,
          c.side,
          id,
          c.marketBidUp,
          c.marketAskUp
        );
        if (range.paper.action === 'BET' && bankroll !== undefined) {
          range.paper.stake = bankroll * range.paper.stakeFraction;
        }
      }
      return range;
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
  }
}
