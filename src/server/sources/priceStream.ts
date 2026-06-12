import { env } from '../cache.ts';
import { CRYPTOS, CRYPTO_IDS, type CryptoId } from '../../shared/cryptos.ts';
import type { PriceTick } from '../../shared/types.ts';

// data-stream.binance.vision is Binance's public websocket mirror: the realtime
// counterpart to the data-api.binance.vision REST mirror (no API key, no
// geo-block). One upstream COMBINED connection carries every tracked crypto's
// ticker and is fanned out to every browser via SSE, so the client never talks
// to Binance directly.
const WS_BASE = env('BINANCE_WS_URL', 'wss://data-stream.binance.vision');

// stream name (e.g. "btcusdt@ticker") → crypto id
const STREAM_TO_CRYPTO = new Map<string, CryptoId>(
  CRYPTO_IDS.map(id => [
    `${CRYPTOS[id].binanceSymbol.toLowerCase()}@ticker`,
    id,
  ])
);

/** The `@ticker` stream pushes ~1 update/sec with last price + 24h stats. */
interface TickerFrame {
  /** last price */
  c: string;
  /** price change percent (24h) */
  P: string;
  /** event time (epoch ms) */
  E: number;
}

/** Combined-stream envelope: which symbol's ticker this frame is. */
interface CombinedFrame {
  stream?: string;
  data?: TickerFrame;
}

type Listener = (tick: PriceTick) => void;

const listeners = new Set<Listener>();
const latest = new Map<CryptoId, PriceTick>();

let ws: WebSocket | null = null;
let started = false;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoffMs = 1_000;

function connect(): void {
  const streams = [...STREAM_TO_CRYPTO.keys()].join('/');
  ws = new WebSocket(`${WS_BASE}/stream?streams=${streams}`);

  ws.onopen = () => {
    backoffMs = 1_000;
  };

  ws.onmessage = event => {
    let frame: CombinedFrame;
    try {
      frame = JSON.parse(String(event.data)) as CombinedFrame;
    } catch {
      return; // ignore malformed frames
    }
    const crypto = STREAM_TO_CRYPTO.get(frame.stream ?? '');
    const data = frame.data;
    if (!crypto || !data) return;
    const tick: PriceTick = {
      crypto,
      price: parseFloat(data.c),
      change24hPct: parseFloat(data.P),
      t: data.E ?? Date.now(),
    };
    if (!Number.isFinite(tick.price)) return;
    latest.set(crypto, tick);
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

/** Most recent tick per crypto (used to seed a new SSE connection). */
export function getLatestTicks(): PriceTick[] {
  return [...latest.values()];
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
      for (const seed of getLatestTicks()) send(seed);
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
