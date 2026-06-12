import { watch } from 'fs';

const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();

export function notifyReload() {
  const chunk = encoder.encode('event: reload\ndata: {}\n\n');
  for (const ctrl of [...clients]) {
    try {
      ctrl.enqueue(chunk);
    } catch {
      clients.delete(ctrl);
    }
  }
  if (clients.size > 0) {
    console.log(`[dev] notified ${clients.size} client(s) to reload`);
  }
}

export function makeSseResponse(req: Request): Response {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  let heartbeat: ReturnType<typeof setInterval>;
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearInterval(heartbeat);
    clients.delete(ctrl);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctrl = c;
      c.enqueue(encoder.encode(': connected\n\n'));
      clients.add(c);
      // Bun doesn't reliably call cancel() when the tab closes, so rely on the
      // request's abort signal to drop dead clients and stop the heartbeat.
      req.signal.addEventListener('abort', cleanup);
      // Keep the connection alive so Bun's idleTimeout doesn't kill it.
      heartbeat = setInterval(() => {
        try {
          c.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          cleanup();
        }
      }, 5_000);
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  });
}

export function watchClientFiles(onRebuild: () => Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Rebuild the client bundle when its source changes, then reload.
  const clientWatcher = watch('src/client', { recursive: true }, () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = null;
      console.log('[dev] client changed, rebuilding…');
      await onRebuild();
      notifyReload();
    }, 150);
  });

  // Static assets (index.html, css, etc.) don't need a rebuild — just reload.
  // Ignore the build output dir so emitting the bundle doesn't loop forever.
  let publicTimer: ReturnType<typeof setTimeout> | null = null;
  const publicWatcher = watch('public', { recursive: true }, (_event, file) => {
    if (file && file.startsWith('dist')) return;
    if (publicTimer) clearTimeout(publicTimer);
    publicTimer = setTimeout(() => {
      publicTimer = null;
      console.log(`[dev] static asset changed (${file ?? '?'}), reloading…`);
      notifyReload();
    }, 150);
  });

  process.on('exit', () => {
    clientWatcher.close();
    publicWatcher.close();
  });
}
