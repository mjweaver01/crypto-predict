import {
  getLatestPrediction,
  msToNextBoundary,
  predict,
  predictAll,
} from './routes/predict.ts';
import { isCryptoId, type CryptoId } from '../shared/cryptos.ts';
import {
  flushLedger,
  getLedger,
  resolvePending,
  summarize,
} from './model/ledger.ts';
import { cached, env } from './cache.ts';
import {
  applyCalibratorFits,
  refreshCalibrators,
} from './model/calibration.ts';
import {
  runCalibrate,
  runMetrics,
  runPaper,
} from './workers/computeClient.ts';
import { getInsights } from './model/insights.ts';
import { makePriceStreamResponse } from './sources/priceStream.ts';
import { getTradeConfig } from './trade/config.ts';
import { getTrades, isOpen, settleTrades } from './trade/tradeLog.ts';
import { redeemSettled } from './trade/redeem.ts';
import { verifyTrades } from './trade/verify.ts';
import type { TradesResponse } from '../shared/types.ts';

// 8333 is Bitcoin's default P2P network port.
const PORT = Number(process.env.PORT ?? 8333);
const PUBLIC = new URL('../../public/', import.meta.url).pathname;
const IS_DEV = process.env.NODE_ENV !== 'production';

// Bundle the client on startup so there is no separate build step in dev.
async function buildClient() {
  const result = await Bun.build({
    entrypoints: ['src/client/live.tsx', 'src/client/history.tsx'],
    outdir: 'public/dist',
    target: 'browser',
    minify: !IS_DEV,
  });
  if (!result.success) {
    console.error('[client build] failed', result.logs);
  } else {
    console.log('[client build] ok');
  }
}
await buildClient();

// Dev live-reload setup.
let makeSseResponse: ((req: Request) => Response) | null = null;
if (IS_DEV) {
  const dev = await import('./dev.ts');
  makeSseResponse = dev.makeSseResponse;
  dev.watchClientFiles(buildClient);
}

const DEV_SCRIPT = `<script>
(function(){
  function connect(){
    var es=new EventSource('/api/__reload');
    es.addEventListener('reload',function(){ location.reload(); });
    es.onerror=function(){
      es.close();
      function tryReconnect(){
        fetch('/api/health').then(function(r){
          if(r.ok) location.reload(); else setTimeout(tryReconnect,1000);
        }).catch(function(){ setTimeout(tryReconnect,1000); });
      }
      setTimeout(tryReconnect,500);
    };
  }
  connect();
})();
</script>`;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// Short TTL for the heavy read endpoints, each of which walks the entire
// (multi-thousand-row) ledger on every call. Without this, history-page polling
// fires a fresh O(n) scan per request and blocks the single JS thread. cached()
// adds stale-while-revalidate, so the recompute happens off the request path
// and the underlying data only changes as windows resolve anyway.
const READ_CACHE_TTL = Number(env('READ_CACHE_TTL', '5')) || 5;
const rangeKey = (from?: number, to?: number) => `${from ?? ''}:${to ?? ''}`;

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname, searchParams } = new URL(req.url);
    // ?crypto=… : a specific asset, or undefined for "all"/unspecified.
    const cryptoParam = searchParams.get('crypto') ?? undefined;
    const crypto: CryptoId | undefined = isCryptoId(cryptoParam)
      ? cryptoParam
      : undefined;
    // Predicate for ledger/trade rows (legacy rows without crypto = btc).
    const inCrypto = (rowCrypto: CryptoId | undefined) =>
      !crypto || (rowCrypto ?? 'btc') === crypto;

    // Shared date-range bounds parsed once, used by metrics, paper, and ledger.
    const fromMs = searchParams.has('from')
      ? Date.parse(searchParams.get('from')!)
      : NaN;
    const toMs = searchParams.has('to')
      ? Date.parse(searchParams.get('to')!)
      : NaN;
    const dateFrom = isNaN(fromMs) ? undefined : fromMs;
    const dateTo = isNaN(toMs) ? undefined : toMs;

    // Dev live-reload SSE stream.
    if (IS_DEV && pathname === '/api/__reload' && makeSseResponse) {
      return makeSseResponse(req);
    }

    // Live spot price stream (SSE fan-out from one Binance websocket).
    if (pathname === '/api/price/stream') return makePriceStreamResponse();

    try {
      if (pathname === '/api/health') return json({ ok: true });
      if (pathname === '/api/predict') {
        // Serve the snapshot the server-side commit loop already computed; the
        // browser never triggers a recompute or records calls. Only on a cold
        // start (before the first cycle finishes) do we compute on demand.
        const c = crypto ?? 'btc';
        return json(getLatestPrediction(c) ?? (await predict(c)));
      }
      if (pathname === '/api/overview') {
        // One snapshot per tracked crypto (cached by the commit loop) — the
        // "All" view's holistic feed.
        return json({ predictions: await predictAll() });
      }
      if (pathname === '/api/ledger') {
        const key = `ledger:${crypto ?? 'all'}:${rangeKey(dateFrom, dateTo)}`;
        return json(
          await cached(key, READ_CACHE_TTL, async () => {
            const allEntries = (await getLedger()).filter(e =>
              inCrypto(e.crypto)
            );
            // All-time summary is always over the full (crypto-filtered) set.
            const summary = summarize(allEntries);

            // Date-range filter applied to windowStart.
            let ranged = allEntries;
            if (dateFrom !== undefined)
              ranged = ranged.filter(
                e => Date.parse(e.windowStart) >= dateFrom
              );
            if (dateTo !== undefined)
              ranged = ranged.filter(e => Date.parse(e.windowStart) <= dateTo);

            // Summary over the date-filtered set — drives the hit-rate headline
            // stats so they reflect the selected window.
            const filteredSummary = summarize(ranged);

            // Newest first; the client virtualizes the full list (no paging).
            const entries = ranged
              .slice()
              .sort(
                (a, b) => Date.parse(b.windowStart) - Date.parse(a.windowStart)
              );

            return { summary, filteredSummary, entries };
          })
        );
      }
      if (pathname === '/api/insights') {
        return json({ entries: getInsights(crypto) });
      }
      if (pathname === '/api/metrics') {
        // Prequential learning-curve scores (raw vs calibrated vs market).
        const key = `metrics:${crypto ?? 'all'}:${rangeKey(dateFrom, dateTo)}`;
        return json(
          await cached(key, READ_CACHE_TTL, () =>
            runMetrics(crypto, dateFrom, dateTo)
          )
        );
      }
      if (pathname === '/api/paper') {
        // Paper-trading replay filtered to the same date window as other views.
        const key = `paper:replay:${crypto ?? 'all'}:${rangeKey(dateFrom, dateTo)}`;
        return json(
          await cached(key, READ_CACHE_TTL, () =>
            runPaper(crypto, dateFrom, dateTo)
          )
        );
      }
      if (pathname === '/api/trades') {
        // Real-money (or dry-run shadow) execution record + halt status.
        const cfg = getTradeConfig();
        const trades = (await getTrades()).filter(t => inCrypto(t.crypto));
        const settled = trades.filter(t => t.settledAt !== undefined);
        const dayStart = new Date().setUTCHours(0, 0, 0, 0);
        const pnlTodayUsd = settled
          .filter(t => Date.parse(t.settledAt!) >= dayStart)
          .reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
        const body: TradesResponse = {
          enabled: cfg.enabled,
          dryRun: cfg.dryRun,
          summary: {
            trades: trades.length,
            open: trades.filter(isOpen).length,
            settled: settled.length,
            wins: settled.filter(t => t.won).length,
            costUsd: settled.reduce((s, t) => s + (t.costUsd ?? 0), 0),
            pnlUsd: settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0),
            pnlTodayUsd,
            halted: pnlTodayUsd <= -cfg.dailyLossLimitUsd,
          },
          trades,
        };
        return json(body);
      }
      if (pathname === '/api/trades/verify' && req.method === 'POST') {
        // Cross-check every live fill against the Polymarket data API. Patches
        // each TradeRecord with fillTxHashes, verifyStatus, verifyNote, etc.
        // Returns the updated trade list so the UI can refresh in one round-trip.
        const counts = await verifyTrades();
        const trades = (await getTrades()).filter(t => inCrypto(t.crypto));
        return json({ counts, trades });
      }
    } catch (err) {
      console.error(err);
      return json({ error: String(err) }, 500);
    }

    // Static files. `/` and `/history` map to their page documents; everything
    // else is served verbatim from public/.
    const rel =
      pathname === '/'
        ? 'index.html'
        : pathname === '/history'
          ? 'history.html'
          : pathname.slice(1);
    const file = Bun.file(PUBLIC + rel);
    if (!(await file.exists()))
      return new Response('Not found', { status: 404 });

    if (IS_DEV && rel.endsWith('.html')) {
      const html = (await file.text()).replace(
        '</body>',
        `${DEV_SCRIPT}</body>`
      );
      return new Response(html, { headers: { 'content-type': 'text/html' } });
    }

    return new Response(file);
  },
});

console.log(
  `Bitcoin Predict → http://localhost:${server.port} ` +
    `(platform: ${getTradeConfig().platform})`
);

// Resolve matured predictions on startup and then on a slow cadence, so the
// track record fills in outcomes without the request path doing it. After each
// resolve pass we refit the calibrators, so freshly settled committed calls feed
// back into how the model is scored — "better as it sees more outcomes".
const resolveLoop = async () => {
  try {
    const n = await resolvePending();
    if (n > 0) console.log(`[ledger] resolved ${n} window(s)`);
  } catch (err) {
    console.warn('[ledger] resolve failed:', err);
  }
  // Refit the calibrators in the analytics worker so the (CRYPTO_IDS×5)
  // logistic fits never block the request thread. Flush first so the worker —
  // which reads the ledger from disk — sees the outcomes resolvePending() just
  // wrote. Fall back to a main-thread refit only if the worker is unavailable.
  try {
    await flushLedger();
    applyCalibratorFits(await runCalibrate());
  } catch (err) {
    console.warn('[calibration] worker refit failed, falling back:', err);
    await refreshCalibrators().catch(e =>
      console.warn('[calibration] refresh failed:', e)
    );
  }
  // Settle real trades against the freshly resolved outcomes, then redeem any
  // winning positions back into USDC (no-ops unless trading is enabled live).
  // Redemption is a Polymarket-only concept — Kalshi settles to cash itself.
  const tradeCfg = getTradeConfig();
  if (tradeCfg.enabled) {
    await settleTrades().catch(err =>
      console.warn('[trade] settle failed:', err)
    );
    if (tradeCfg.platform === 'polymarket') {
      await redeemSettled().catch(err =>
        console.warn('[trade] redeem failed:', err)
      );
    }
  }
};
void resolveLoop();
setInterval(resolveLoop, 60_000);

// Commit ticker: drive predict() on a fixed cadence so committed calls are
// locked in (and the ledger keeps growing) even when no browser is polling the
// dashboard. recordPredictions() runs inside predict() on each real recompute,
// so this is what makes the system "learn on its own" while running unattended.
// Matches the predict cache TTL (CACHE_TTL_PREDICT, 1s) so each tick recomputes
// exactly one fresh snapshot. Underlying Binance/Polymarket fetches are cached
// independently, so this never hammers the upstream APIs.
const COMMIT_TICK_MS = Math.max(
  1_000,
  Number(env('COMMIT_TICK_SECONDS', '1')) * 1000 || 1_000
);
const commitLoop = async () => {
  try {
    await predictAll();
  } catch (err) {
    console.warn('[commit] tick failed:', err);
  }
};
void commitLoop();
setInterval(commitLoop, COMMIT_TICK_MS);

// Boundary kick: the fixed tick can land up to COMMIT_TICK_MS after a market
// window closes, leaving the old window on screen. Recompute right after every
// 5m boundary (the lattice all windows close on) so the new window's strike and
// committed call exist the moment a countdown hits zero. The small cushion lets
// the boundary 1m candle land first.
const BOUNDARY_CUSHION_MS = 500;
const scheduleBoundaryKick = () => {
  setTimeout(async () => {
    await commitLoop();
    scheduleBoundaryKick();
  }, msToNextBoundary() + BOUNDARY_CUSHION_MS);
};
scheduleBoundaryKick();
