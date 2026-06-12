/**
 * Backfill the prediction ledger with historical COMMITTED calls vs outcomes,
 * so the learned calibrator (src/server/model/calibration.ts) has data to fit on
 * immediately instead of waiting days for live outcomes to accumulate.
 *
 * For recent RESOLVED 5m / 15m / 1h windows we reconstruct the model's RAW
 * probability EARLY in the window (one minute after the open — mirroring where
 * we commit a call live, while the horizon is still long), pair it with the REAL
 * Polymarket resolution, and write it to data/ledger.json with `rawProbUp` set
 * so refreshCalibrators() picks it up. This matches the distribution the
 * calibrator is applied to: forward-looking calls, not pre-close snapshots.
 *
 * The daily (1d) family is handled separately: its windows are noon-ET to
 * noon-ET, it settles on the Binance 1m close at noon, and it forecasts over a
 * ~24h horizon (long-run hourly stats). We reconstruct each daily call ~1 min
 * after the noon open using only candles available by then, pair it with the
 * real Polymarket daily outcome, and write it with `rawProbUp` set so the daily
 * calibrator activates immediately instead of taking ~25 days to accumulate.
 *
 * Each row also reconstructs the commit-time FEATURE record (features.ts) —
 * momentum, vol regime, seasonality, and the historical Polymarket implied
 * probability at the decision instant (CLOB price history) — so the learned
 * layer trains on exactly what the live path would have seen.
 *
 * Usage:  bun run backfill [-- --crypto all|btc|eth|… --count5 144 --count15 96 --count1h 48 --count1d 180]
 */
import {
  fetchCandleAt,
  fetchKlineRange,
  type Candle,
} from '../src/server/sources/binance.ts';
import {
  fetchMarketOutcome,
  fetchPriceHistory,
  marketSlug,
  type PricePointRaw,
} from '../src/server/sources/polymarket.ts';
import {
  buildModel,
  predictAbove,
  sigmaPerMinFor,
  type Model,
} from '../src/server/model/forecast.ts';
import { extractFeatures } from '../src/server/model/features.ts';
import { addEntries, getLedger } from '../src/server/model/ledger.ts';
import { dailyWindowAt, noonEtUtc } from '../src/server/model/windows.ts';
import {
  CRYPTOS,
  CRYPTO_IDS,
  isCryptoId,
  type CryptoId,
} from '../src/shared/cryptos.ts';
import type { LedgerEntry, RangeId, Side } from '../src/shared/types.ts';

const MIN = 60_000;
const WARMUP_MIN = 240;

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]);
  return fallback;
}

function strArg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]!;
  return fallback;
}

interface Fam {
  id: Exclude<RangeId, '1d'>;
  windowMin: number;
  count: number;
}
const FAMS: Fam[] = [
  { id: '5m', windowMin: 5, count: arg('count5', 144) },
  { id: '15m', windowMin: 15, count: arg('count15', 96) },
  { id: '1h', windowMin: 60, count: arg('count1h', 48) },
  { id: '4h', windowMin: 240, count: arg('count4h', 42) },
];

async function mapPool<T, R>(
  items: T[],
  n: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function recentWindowStarts(windowMin: number, count: number): number[] {
  const windowMs = windowMin * MIN;
  const lastClosed =
    Math.floor(Date.now() / windowMs) * windowMs - 2 * windowMs;
  return Array.from({ length: count }, (_, i) => lastClosed - i * windowMs);
}

// Daily resolves once a day, so reach far back (Polymarket history permitting)
// or the 1d learner would take months to see a meaningful sample.
const COUNT_1D = arg('count1d', 180);

/**
 * Market-implied P(up) at `decisionSec` from a CLOB price history: the last
 * sample at or before it. Undefined when no quote existed yet — we must not
 * fabricate a 0.5 quote, or the learner would train on invented market data.
 */
function marketAt(
  history: PricePointRaw[],
  decisionSec: number
): number | undefined {
  let p: number | undefined;
  for (const pt of history) {
    if (pt.t <= decisionSec) p = pt.p;
    else break;
  }
  return p === undefined ? undefined : Math.min(1, Math.max(0, p));
}

/**
 * The most recent `count` CLOSED daily windows (noon ET → noon ET), newest
 * first. The active window's start is the most recent past noon, i.e. the end
 * of the last closed window; we then walk back one ET day at a time (snapping to
 * noon each step so DST transitions stay aligned).
 */
function recentDailyWindows(count: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let end = dailyWindowAt(Date.now()).start; // last closed window's close
  for (let i = 0; i < count; i++) {
    const start = noonEtUtc(end - 18 * 3_600_000); // the noon before `end`
    out.push({ start, end });
    end = start;
  }
  return out;
}

async function backfillCrypto(
  crypto: CryptoId,
  existingIds: Set<string>
): Promise<void> {
  const symbol = CRYPTOS[crypto].binanceSymbol;
  console.log(`\n═══ ${CRYPTOS[crypto].label} (${symbol}) ═══`);
  /**
   * Skip windows the ledger already has: live rows carry real commit-time
   * book data a backfill can't reconstruct, and btc history predates the
   * `${crypto}:` id prefix, so check the legacy id form too.
   */
  const alreadyRecorded = (rangeId: RangeId, startMs: number): boolean =>
    existingIds.has(`${crypto}:${rangeId}:${startMs}`) ||
    (crypto === 'btc' && existingIds.has(`${rangeId}:${startMs}`));
  // Oldest 1m candle we need: the oldest window start across the intraday
  // families, minus the warmup.
  const oldestIntraday = Math.min(
    ...FAMS.map(f => recentWindowStarts(f.windowMin, f.count).at(-1)!)
  );
  const klStart = oldestIntraday - (WARMUP_MIN + 5) * MIN;
  // Daily windows reach much further back than the 1h family, so the hourly
  // warmup must cover the oldest daily start too.
  const dailyWindows = recentDailyWindows(COUNT_1D);
  const oldestDailyStart = dailyWindows.at(-1)!.start;
  console.log('fetching klines…');
  // Fetch 1h candles far enough back that the long-horizon EWMA has warmed up
  // by the oldest window (the live model uses 720 hourly candles).
  const HOUR = 60 * MIN;
  const hourStart = Math.min(oldestIntraday, oldestDailyStart) - 720 * HOUR;
  const [candles, hourCandlesAll] = await Promise.all([
    fetchKlineRange('1m', klStart, Date.now(), symbol),
    fetchKlineRange('1h', hourStart, Date.now(), symbol),
  ]);
  const byOpen = new Map<number, Candle>();
  for (const c of candles) byOpen.set(c.openTime, c);
  const opens = [...byOpen.keys()].sort((a, b) => a - b);
  const idxOf = new Map<number, number>();
  opens.forEach((t, i) => idxOf.set(t, i));
  const hourSorted = [...hourCandlesAll].sort(
    (a, b) => a.openTime - b.openTime
  );
  console.log(
    `fetched ${candles.length} 1m + ${hourSorted.length} 1h candles\n`
  );

  /** Completed hourly candles strictly before an instant (no look-ahead). */
  function hoursBefore(instantMs: number): Candle[] {
    return hourSorted.filter(c => c.openTime < instantMs);
  }

  /**
   * Raw model probUp committed ~1 minute into the window, using only candles
   * available by then — mirroring the live committed-call timing (locked in
   * early, while the horizon is still long). The strike is the window open; the
   * decision price is the close of the first 1m candle after the open.
   */
  function modelProbAtCommit(
    startMs: number,
    windowMin: number
  ): {
    probUp: number;
    horizon: number;
    model: Model;
    trailing: Candle[];
    hourTrailing: Candle[];
    price: number;
  } | null {
    const openCandle = byOpen.get(startMs);
    const idx = idxOf.get(startMs); // candle opening at the window start
    if (!openCandle || idx === undefined || idx < WARMUP_MIN) return null;
    const trailing: Candle[] = [];
    for (let j = idx - WARMUP_MIN + 1; j <= idx; j++) {
      trailing.push(byOpen.get(opens[j]!)!);
    }
    const horizon = windowMin - 1; // one minute elapsed at commit
    const hourTrailing = hoursBefore(startMs);
    const model = buildModel({
      price: openCandle.close, // price one minute into the window
      change24hPct: 0,
      minuteCandles: trailing,
      // Long-horizon families (1h) need real hourly stats; supplying only
      // completed hours up to the window start avoids look-ahead. 5m/15m use
      // minute stats so this is harmless for them.
      hourCandles: hourTrailing,
    });
    return {
      probUp: predictAbove(model, openCandle.open, horizon, '').probAbove,
      horizon,
      model,
      trailing,
      hourTrailing,
      price: openCandle.close,
    };
  }

  const all: LedgerEntry[] = [];
  for (const fam of FAMS) {
    const starts = recentWindowStarts(fam.windowMin, fam.count);
    const rows = await mapPool(starts, 6, async startMs => {
      if (alreadyRecorded(fam.id, startMs)) return null;
      const endMs = startMs + fam.windowMin * MIN;
      const slug = marketSlug(crypto, fam.id, startMs);
      const outcome = await fetchMarketOutcome(slug);
      if (!outcome) return null;
      const call = modelProbAtCommit(startMs, fam.windowMin);
      if (call === null) return null;
      const decidedMs = startMs + MIN;
      // Historical market-implied P(up) at the commit instant, so the
      // learner's market feature trains on real (not invented) quotes.
      const history = await fetchPriceHistory(outcome.upTokenId);
      const marketImpliedUp = marketAt(history, Math.floor(decidedMs / 1000));
      const strike = byOpen.get(startMs)!.open;
      const features = extractFeatures({
        family: fam.id,
        price: call.price,
        strike,
        horizonMinutes: call.horizon,
        sigmaPerMin: sigmaPerMinFor(call.model, call.horizon),
        minuteCandles: call.trailing,
        hourCandles: call.hourTrailing,
        marketImpliedUp,
        now: decidedMs,
      });
      const probUp = call.probUp;
      const side: Side = probUp >= 0.5 ? 'UP' : 'DOWN';
      const realized: Side = outcome.outcomeUp ? 'UP' : 'DOWN';
      const entry: LedgerEntry = {
        id: `${crypto}:${fam.id}:${startMs}`,
        crypto,
        rangeId: fam.id,
        slug,
        windowStart: new Date(startMs).toISOString(),
        windowEnd: new Date(endMs).toISOString(),
        strike,
        probUp,
        // No live calibrator existed historically, so raw == committed prob.
        rawProbUp: probUp,
        side,
        confidence: Math.max(probUp, 1 - probUp),
        marketImpliedUp,
        features,
        horizonMinutes: call.horizon,
        decidedAt: new Date(decidedMs).toISOString(),
        source: 'backfill',
        outcome: realized,
        correct: side === realized,
        resolvedBy: 'polymarket',
        resolvedAt: new Date().toISOString(),
      };
      return entry;
    });
    const got = rows.filter((r): r is LedgerEntry => r !== null);
    const correct = got.filter(e => e.correct).length;
    console.log(
      `${fam.id}: ${got.length}/${fam.count} resolved · accuracy ${
        got.length ? ((correct / got.length) * 100).toFixed(1) : '—'
      }%`
    );
    all.push(...got);
  }

  // ── Daily family (noon ET → noon ET) ──────────────────────────────────────
  // Reconstruct each daily call ~1 min after the noon open: strike = the 1m
  // close at noon (how the daily market settles), decision price = the 1m close
  // one minute later, horizon = the rest of the ~24h window. Long-horizon stats
  // come from completed hourly candles strictly before the open (no look-ahead);
  // minute stats are unused at this horizon, so we don't fetch a 1m history.
  const dailyRows = await mapPool(dailyWindows, 6, async ({ start, end }) => {
    if (alreadyRecorded('1d', start)) return null;
    const slug = marketSlug(crypto, '1d', end);
    const outcome = await fetchMarketOutcome(slug);
    if (!outcome) return null;
    const [noonCandle, decisionCandle] = await Promise.all([
      fetchCandleAt('1m', start, symbol).catch(() => null),
      fetchCandleAt('1m', start + MIN, symbol).catch(() => null),
    ]);
    if (!noonCandle || !decisionCandle) return null;
    const strike = noonCandle.close; // daily settles on the 1m close at noon
    const price = decisionCandle.close; // price ~1 min into the window
    const windowMin = Math.round((end - start) / MIN);
    const horizon = windowMin - 1;
    const decidedMs = start + MIN;
    const hourTrailing = hourSorted.filter(c => c.openTime < start);
    const model = buildModel({
      price,
      change24hPct: 0,
      minuteCandles: [], // unused at a 24h horizon (long-run hourly stats)
      hourCandles: hourTrailing,
    });
    const history = await fetchPriceHistory(outcome.upTokenId);
    const marketImpliedUp = marketAt(history, Math.floor(decidedMs / 1000));
    const features = extractFeatures({
      family: '1d',
      price,
      strike,
      horizonMinutes: horizon,
      sigmaPerMin: sigmaPerMinFor(model, horizon),
      minuteCandles: [],
      hourCandles: hourTrailing,
      marketImpliedUp,
      now: decidedMs,
    });
    const probUp = predictAbove(model, strike, horizon, '').probAbove;
    const side: Side = probUp >= 0.5 ? 'UP' : 'DOWN';
    const realized: Side = outcome.outcomeUp ? 'UP' : 'DOWN';
    const entry: LedgerEntry = {
      id: `${crypto}:1d:${start}`,
      crypto,
      rangeId: '1d',
      slug,
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(end).toISOString(),
      strike,
      probUp,
      rawProbUp: probUp,
      side,
      confidence: Math.max(probUp, 1 - probUp),
      marketImpliedUp,
      features,
      horizonMinutes: horizon,
      decidedAt: new Date(decidedMs).toISOString(),
      source: 'backfill',
      outcome: realized,
      correct: side === realized,
      resolvedBy: 'polymarket',
      resolvedAt: new Date().toISOString(),
    };
    return entry;
  });
  const dailyGot = dailyRows.filter((r): r is LedgerEntry => r !== null);
  const dailyCorrect = dailyGot.filter(e => e.correct).length;
  console.log(
    `1d: ${dailyGot.length}/${COUNT_1D} resolved · accuracy ${
      dailyGot.length
        ? ((dailyCorrect / dailyGot.length) * 100).toFixed(1)
        : '—'
    }%`
  );
  all.push(...dailyGot);

  await addEntries(all);
  console.log(
    `wrote ${all.length} backfilled ${crypto} entries to the ledger.`
  );
}

async function main() {
  const which = strArg('crypto', 'all');
  const cryptos: CryptoId[] = isCryptoId(which) ? [which] : [...CRYPTO_IDS];
  // Pre-load existing ids once: windows already in the ledger (live rows with
  // real book data, or a prior backfill) must not be overwritten.
  const existingIds = new Set((await getLedger()).map(e => e.id));
  for (const crypto of cryptos) {
    await backfillCrypto(crypto, existingIds);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
