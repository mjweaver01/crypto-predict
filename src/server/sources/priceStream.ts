import { env } from '../cache.ts';
import type { PriceTick } from '../../shared/types.ts';

// data-stream.binance.vision is Binance's public websocket mirror: the realtime
// counterpart to the data-api.binance.vision REST mirror (no API key, no
// geo-block). One upstream connection is held here and fanned out to every
// browser via SSE, so the client never talks to Binance directly.
const WS_BASE = env('BINANCE_WS_URL', 'wss://data-stream.binance.vision');
const SYMBOL = env('BTC_SYMBOL', 'BTCUSDT').toLowerCase();

/** The `@ticker` stream pushes ~1 update/sec with last price + 24h stats. */
interface TickerFrame {
  /** last price */
  c: string;
  /** price change percent (24h) */
  P: string;
  /** event time (epoch ms) */
  E: number;
}

type Listener = (tick: PriceTick) => void;

const listeners = new Set<Listener>();
let latest: PriceTick | null = null;

let ws: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1_000;

function connect(): void {
  ws = new WebSocket(`${WS_BASE}/ws/${SYMBOL}@ticker`);

  ws.onopen = () => {
    backoffMs = 1_000;
  };

  ws.onmessage = event => {
    let frame: TickerFrame;
    try {
      frame = JSON.parse(String(event.data)) as TickerFrame;
    } catch {
      return; // ignore malformed frames
    }
    const tick: PriceTick = {
      price: parseFloat(frame.c),
      change24hPct: parseFloat(frame.P),
      t: frame.E ?? Date.now(),
    };
    if (!Number.isFinite(tick.price)) return;
    latest = tick;
    for (const fn of listeners) {
      try {
        fn(tick);
      } catch {
        // A single bad listener must not break the fan-out loop.
      }
    }
  };

  // close → reconnect; error is followed by close, so let close drive retries.
  ws.onclose = () => scheduleReconnect();
  ws.onerror = () => {
    try {
      ws?.close();
    } catch {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect(): void {
  ws = null;
  if (reconnectTimer) return; // a retry is already pending
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, 30_000);
}

/** Start the upstream connection once, lazily, on first use. */
function ensureConnected(): void {
  if (started) return;
  started = true;
  connect();
}

/** Subscribe to live ticks; returns an unsubscribe function. */
export function onTick(fn: Listener): () => void {
  ensureConnected();
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Most recent tick seen, if any (used to seed a new SSE connection). */
export function getLatestTick(): PriceTick | null {
  return latest;
}

const encoder = new TextEncoder();

/**
 * An SSE response that emits one `data:` frame per live tick. Seeds the latest
 * known tick immediately on connect and sends comment pings so Bun's idle
 * timeout (and proxies) don't drop the long-lived stream.
 */
export function makePriceStreamResponse(): Response {
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval>;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (tick: PriceTick) => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(tick)}\n\n`)
          );
        } catch {
          unsubscribe?.();
        }
      };

      controller.enqueue(encoder.encode(': connected\n\n'));
      const seed = getLatestTick();
      if (seed) send(seed);
      unsubscribe = onTick(send);

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);
    },
    cancel() {
      clearInterval(heartbeat);
      unsubscribe?.();
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
