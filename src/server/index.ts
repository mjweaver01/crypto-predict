import { predict } from './routes/predict.ts';

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
    const { pathname, searchParams } = new URL(req.url);

    // Dev live-reload SSE stream.
    if (IS_DEV && pathname === '/api/__reload' && makeSseResponse) {
      return makeSseResponse();
    }

    try {
      if (pathname === '/api/health') return json({ ok: true });
      if (pathname === '/api/predict') {
        const strikeRaw = searchParams.get('strike');
        const target = searchParams.get('target') ?? undefined;
        const strike = strikeRaw ? Number(strikeRaw) : undefined;
        return json(
          await predict({
            strike: Number.isFinite(strike) ? strike : undefined,
            target,
          })
        );
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
