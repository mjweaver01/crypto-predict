import { getLatestPrediction, predict } from './routes/predict.ts';
import { getLedger, resolvePending, summarize } from './model/ledger.ts';
import { env } from './cache.ts';
import { refreshCalibrators } from './model/calibration.ts';
import { getInsights } from './model/insights.ts';
import { makePriceStreamResponse } from './sources/priceStream.ts';

// 8333 is Bitcoin's default P2P network port.
const PORT = Number(process.env.PORT ?? 8333);
const PUBLIC = new URL('../../public/', import.meta.url).pathname;
const IS_DEV = process.env.NODE_ENV !== 'production';

// Bundle the client on startup so there is no separate build step in dev.
async function buildClient() {
  const result = await Bun.build({
    entrypoints: ['src/client/main.ts'],
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
let makeSseResponse: (() => Response) | null = null;
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

const server = Bun.serve({
  port: PORT,
  idleTimeout: 0,
  async fetch(req) {
    const { pathname } = new URL(req.url);

    // Dev live-reload SSE stream.
    if (IS_DEV && pathname === '/api/__reload' && makeSseResponse) {
      return makeSseResponse();
    }

    // Live spot price stream (SSE fan-out from one Binance websocket).
    if (pathname === '/api/price/stream') return makePriceStreamResponse();

    try {
      if (pathname === '/api/health') return json({ ok: true });
      if (pathname === '/api/predict') {
        // Serve the snapshot the server-side commit loop already computed; the
        // browser never triggers a recompute or records calls. Only on a cold
        // start (before the first cycle finishes) do we compute on demand.
        return json(getLatestPrediction() ?? (await predict()));
      }
      if (pathname === '/api/ledger') {
        const entries = await getLedger();
        return json({ summary: summarize(entries), entries });
      }
      if (pathname === '/api/insights') {
        return json({ entries: getInsights() });
      }
    } catch (err) {
      console.error(err);
      return json({ error: String(err) }, 500);
    }

    // Static files.
    const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
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

console.log(`Bitcoin Predict → http://localhost:${server.port}`);

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
  await refreshCalibrators().catch(err =>
    console.warn('[calibration] refresh failed:', err)
  );
};
void resolveLoop();
setInterval(resolveLoop, 60_000);

// Commit ticker: drive predict() on a fixed cadence so committed calls are
// locked in (and the ledger keeps growing) even when no browser is polling the
// dashboard. recordPredictions() runs inside predict() on each real recompute,
// so this is what makes the system "learn on its own" while running unattended.
// Matches the predict cache TTL (CACHE_TTL_PREDICT, 20s) so each tick recomputes
// exactly one fresh snapshot. Underlying Binance/Polymarket fetches are cached
// independently, so this never hammers the upstream APIs.
const COMMIT_TICK_MS = Math.max(
  1_000,
  Number(env('COMMIT_TICK_SECONDS', '20')) * 1000 || 20_000
);
const commitLoop = async () => {
  try {
    await predict();
  } catch (err) {
    console.warn('[commit] tick failed:', err);
  }
};
void commitLoop();
setInterval(commitLoop, COMMIT_TICK_MS);
