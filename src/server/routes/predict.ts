import { cached, env } from '../cache.ts';
import {
  fetch24hChangePct,
  fetchCandleAt,
  fetchCandles,
  fetchPrice,
} from '../sources/binance.ts';
import {
  buildModel,
  predictAbove,
  predictPrice,
  sigmaPerMinFor,
} from '../model/forecast.ts';
import { extractFeatures } from '../model/features.ts';
import { buildNarrative } from '../model/narrative.ts';
import { recordPredictions } from '../model/ledger.ts';
import { decide, ensureHydrated } from '../model/commitments.ts';
import {
  costOfSide,
  decideBet,
  feeAdjustedCost,
  fillSide,
  getPolicy,
} from '../model/paper.ts';
import { runBankroll } from '../workers/computeClient.ts';
import {
  applyCalibration,
  calibrationInfo,
  getCalibrator,
} from '../model/calibration.ts';
import { recordInsight } from '../model/insights.ts';
import { executeTrades } from '../trade/executor.ts';
import { dailyWindowAt } from '../model/windows.ts';
import {
  fetchMarketQuote,
  fetchPlatformStrike,
  marketIdFor,
  resolutionSourceFor,
} from '../sources/market.ts';
import { CRYPTOS, CRYPTO_IDS, type CryptoId } from '../../shared/cryptos.ts';
import type {
  Prediction,
  PricePoint,
  RangeId,
  RangePrediction,
  ServerSpotRangeId,
} from '../../shared/types.ts';

const TTL = Number(env('CACHE_TTL_PREDICT', '1'));
// Bankroll is global (one number across all cryptos) and changes only as bets
// resolve, so a few seconds of staleness on the live stake display is fine.
const BANKROLL_TTL = 5;

/**
 * The most recent prediction per crypto computed by the server-side commit
 * loop. The browser reads these snapshots instead of triggering a recompute,
 * so ALL data generation (committing calls, recording insights) happens on the
 * server's own cadence rather than as a side effect of an HTTP request.
 */
const latestByCrypto = new Map<CryptoId, Prediction>();

/**
 * The latest server-computed prediction for a crypto, or null before the first
 * cycle — or when the snapshot straddles a window boundary (some window already
 * closed). Returning null in that case makes the API path recompute
 * immediately, so the dashboard shows the new window's wager as soon as the
 * countdown hits zero instead of waiting out the commit tick.
 */
export function getLatestPrediction(
  crypto: CryptoId = 'btc'
): Prediction | null {
  const latest = latestByCrypto.get(crypto);
  if (!latest) return null;
  const now = Date.now();
  const stale = latest.ranges.some(r => Date.parse(r.windowEnd) <= now);
  return stale ? null : latest;
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

// Labels are platform-independent; what each family's market settles against
// is not (Polymarket: Chainlink for 5m/15m/4h; Kalshi: CF Benchmarks for its
// 15m family) — resolutionSourceFor() answers per the active platform.
const LABELS: Record<RangeId, string> = {
  '5m': '5 min',
  '15m': '15 min',
  '1h': 'Hourly',
  '4h': '4 hour',
  '1d': 'Daily',
};

/** Ms until the next 5m boundary — the lattice every market window closes on
 * (15m/1h are multiples; the daily noon-ET close is on the hour). */
export function msToNextBoundary(now = Date.now()): number {
  return floorTo(now, MS['5m']) + MS['5m'] - now;
}

export async function predict(crypto: CryptoId = 'btc'): Promise<Prediction> {
  // Never let a cached snapshot outlive a window boundary: clamp the TTL so the
  // entry expires the moment any market window closes and the next call
  // recomputes with the new window's strike + committed call.
  const ttl = Math.max(1, Math.min(TTL, Math.ceil(msToNextBoundary() / 1000)));
  const p = await cached(`predict:ranges:${crypto}`, ttl, () =>
    computePrediction(crypto)
  );
  latestByCrypto.set(crypto, p);
  return p;
}

/**
 * Compute (or serve cached) predictions for every tracked crypto. Sequential
 * failures are isolated — one asset's upstream hiccup never blocks the rest.
 */
export async function predictAll(): Promise<Prediction[]> {
  const results = await Promise.allSettled(CRYPTO_IDS.map(c => predict(c)));
  return results
    .filter(
      (r): r is PromiseFulfilledResult<Prediction> => r.status === 'fulfilled'
    )
    .map(r => r.value);
}

async function computePrediction(crypto: CryptoId): Promise<Prediction> {
  {
    const now = Date.now();
    const win = windowsAt(now);
    const symbol = CRYPTOS[crypto].binanceSymbol;

    // Load any still-open committed calls from the ledger before we decide, so
    // a restart mid-window keeps the call we already locked in.
    await ensureHydrated();

    // Current paper bankroll, so a live BET verdict can state its dollar stake
    // (the replay sizes open bets at this same running bankroll). The replay is
    // a full O(n) pass over the ledger; it's identical for every crypto on a
    // tick and the bankroll only inches between resolutions, so cache it briefly
    // rather than re-running it six times a second.
    let bankroll: number | undefined;
    try {
      // Replay runs in the analytics worker so this 5s-cadence sim never blocks
      // the commit loop's single thread; the main-thread cache still collapses
      // the per-crypto calls in a tick into one worker round-trip.
      bankroll = await cached('paper:bankroll', BANKROLL_TTL, () =>
        runBankroll()
      );
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
      platformStrike5m,
      platformStrike15m,
      platformStrike4h,
    ] = await Promise.all([
      fetchPrice(symbol),
      fetch24hChangePct(symbol),
      fetchCandles('1m', 240, symbol),
      fetchCandles('5m', 80, symbol),
      fetchCandles('1h', 720, symbol),
      fetchCandleAt('1m', win['5m'].start, symbol),
      fetchCandleAt('1m', win['15m'].start, symbol),
      fetchCandleAt('1m', win['1h'].start, symbol),
      fetchCandleAt('1m', win['4h'].start, symbol),
      fetchCandleAt('1m', win['1d'].start, symbol),
      // The platform's exact "price to beat" where it exposes one (Polymarket:
      // Chainlink-derived 5m/15m/4h; Kalshi: the 15m floor_strike).
      fetchPlatformStrike('5m', win['5m'].start, win['5m'].end, crypto).catch(
        () => undefined
      ),
      fetchPlatformStrike(
        '15m',
        win['15m'].start,
        win['15m'].end,
        crypto
      ).catch(() => undefined),
      fetchPlatformStrike('4h', win['4h'].start, win['4h'].end, crypto).catch(
        () => undefined
      ),
    ]);

    const model = buildModel({
      price,
      change24hPct,
      minuteCandles,
      hourCandles,
    });

    // Strike (price to beat) per family, anchored to how each market settles.
    // Where the platform exposes its EXACT settlement open (Polymarket's
    // crypto-price API / Kalshi's floor_strike) we use that; only if it's
    // unavailable do we fall back to the Binance 1m-open proxy (which carries
    // a basis error vs Chainlink / CF Benchmarks). Families that settle on
    // Binance itself (1h/1d on Polymarket; everything without a Kalshi
    // market) get the exact boundary candle directly.
    const strikeByRange: Record<RangeId, number> = {
      '5m':
        platformStrike5m ??
        open5m?.open ??
        strikeAt(win['5m'].start, fiveMinCandles, minuteCandles, price),
      '15m':
        platformStrike15m ??
        open15m?.open ??
        strikeAt(win['15m'].start, fiveMinCandles, minuteCandles, price),
      '1h':
        open1h?.open ??
        candleOpenAt(hourCandles, win['1h'].start) ??
        lastCloseBefore(hourCandles, win['1h'].start) ??
        price,
      '4h':
        platformStrike4h ??
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

    // A strike is only a "proxy" when the family settles off-Binance (per the
    // active platform) and the platform's exact open wasn't available, so we
    // fell back to the Binance boundary candle.
    const platformStrikes: Partial<Record<RangeId, number | undefined>> = {
      '5m': platformStrike5m,
      '15m': platformStrike15m,
      '4h': platformStrike4h,
    };
    const strikeIsProxyByRange = Object.fromEntries(
      (['5m', '15m', '1h', '4h', '1d'] as RangeId[]).map(id => [
        id,
        resolutionSourceFor(id) !== 'binance' &&
          platformStrikes[id] === undefined,
      ])
    ) as Record<RangeId, boolean>;

    const order: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];

    const markets = await Promise.all(
      order.map(id => {
        const w = win[id];
        const marketId = marketIdFor(crypto, id, w.start, w.end);
        if (!marketId) return null; // family not offered on this platform
        return fetchMarketQuote(marketId, w.start, w.end).catch(() => null);
      })
    );

    // Ground the narrative in the model's own per-window calls (base P(up),
    // the price to beat, and market-implied odds) so it cites concrete levels
    // instead of restating raw stats.
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
        label: LABELS[id],
        horizonMin: remaining,
        strike,
        probUp,
        marketImpliedUp: markets[i]?.impliedUp,
      };
    });
    const narrative = buildNarrative(model, {
      asset: `${CRYPTOS[crypto].ticker}/USDT`,
      price,
      reads,
    });

    const ranges: RangePrediction[] = order.map((id, i) => {
      const w = win[id];
      const strike = strikeByRange[id];
      // Precise (possibly sub-minute) horizon: rounding to whole minutes near a
      // boundary overstates remaining variance and drags near-certain outcomes
      // back toward 50/50. Floor at 1 second to avoid a zero-vol singularity.
      const remaining = Math.max(1 / 60, (w.end - now) / 60_000);
      const endIso = new Date(w.end).toISOString();
      // Raw statistical model probability, then the learned layer fit from
      // our resolved track record. probUp is what we show and bet on;
      // rawProbUp + features are preserved so the learner keeps training on a
      // stationary signal rather than its own corrected output.
      const rawProbUp = predictAbove(
        model,
        strike,
        remaining,
        endIso
      ).probAbove;
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
      const probUp = applyCalibration(
        rawProbUp,
        features,
        getCalibrator(id, crypto)
      );
      const range: RangePrediction = {
        id,
        crypto,
        label: LABELS[id],
        resolutionSource: resolutionSourceFor(id),
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
        calibration: calibrationInfo(id, crypto),
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
          const policy = getPolicy();
          // Intended size: fractional-Kelly bankroll slice, capped in dollars.
          const requested = Math.min(
            bankroll * range.paper.stakeFraction,
            policy.maxStakeUsd
          );
          // Walk the frozen commit-time book exactly as the replay does, so the
          // live stake is what the (often thin) book could actually fill rather
          // than the optimistic touch-price request. Rows without stored depth
          // fall back to the full request, matching the replay's behaviour.
          const hasDepth =
            (c.marketUpBids?.length ?? 0) > 0 ||
            (c.marketUpAsks?.length ?? 0) > 0;
          const rawTouch = costOfSide(c.side, c.marketBidUp, c.marketAskUp);
          if (hasDepth && rawTouch !== undefined) {
            const f = fillSide(
              c.side,
              requested,
              c.marketUpBids,
              c.marketUpAsks,
              rawTouch + policy.fillSlippage
            );
            if (f) {
              range.paper.stake = f.stake;
              range.paper.depthCapped =
                f.stake < requested - 1e-9 ? true : undefined;
              // Replace the touch cost with the depth-weighted average actually
              // paid (fee-adjusted), so the displayed cost/payout match the
              // stake we just sized — the replay records the achieved cost the
              // same way. Edge stays the touch-based gate value from decideBet.
              range.paper.cost = feeAdjustedCost(
                f.cost,
                policy.takerFeeBps,
                policy.feeModel
              );
            } else {
              // Nothing fillable within the slippage cap — not a real bet, so
              // flip to PASS exactly as the replay does instead of showing $0.
              range.paper = {
                action: 'PASS',
                side: c.side,
                cost: range.paper.cost,
                edge: range.paper.edge,
                stakeFraction: 0,
                reason: 'no-book',
              };
            }
          } else {
            range.paper.stake = requested;
          }
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
      crypto,
      symbol,
      stats: model.stats,
      ranges,
      narrative,
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

    // Real-money execution on freshly committed BET verdicts. Inert unless
    // TRADING_ENABLED; dry-run by default. Fire-and-forget for the same reason
    // as the ledger write — the prediction response never waits on the CLOB.
    void executeTrades(prediction, now).catch(err =>
      console.warn('[trade] execute failed:', err)
    );

    return prediction;
  }
}
