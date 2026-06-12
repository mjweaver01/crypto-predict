// Reactive state + side-effect wiring for the live dashboard. Everything the
// old live.ts kept in module-level `let`s now lives in signals, so components
// re-render only when the data they read actually changes — no more wholesale
// innerHTML rebuilds every second.

import { effect, signal } from '@preact/signals';
import type {
  Prediction,
  PriceTick,
  PricePoint,
  RangeId,
  SpotRangeId,
  TradesResponse,
} from '../../shared/types.ts';
import { type CryptoId } from '../../shared/cryptos.ts';
import { loadPref, savePref } from '../format.ts';
import { selectedCrypto } from '../crypto.ts';

export const RANGE_IDS: readonly RangeId[] = ['5m', '15m', '1h', '4h', '1d'];
export const SPOT_RANGES: SpotRangeId[] = ['LIVE', '1H', '6H', '1D', '1W'];

// ── Selections (persisted) ───────────────────────────────────────────────
export const selectedTab = signal<RangeId>(loadPref('tab', RANGE_IDS, '5m'));
export const selectedSpot = signal<SpotRangeId>(
  loadPref('spot', SPOT_RANGES, '1D')
);
effect(() => savePref('tab', selectedTab.value));
effect(() => savePref('spot', selectedSpot.value));

// ── Server data ──────────────────────────────────────────────────────────
export const latest = signal<Prediction | null>(null);
export const latestAll = signal<Prediction[] | null>(null);
export const errorMsg = signal('');
export const updatedAt = signal('');
export const loading = signal(true);
export const liveTrading = signal(false);

/** Ticks every second, driving countdowns + expiry-triggered refetches. */
export const now = signal(Date.now());

// ── Stream-driven spot (focused crypto) ──────────────────────────────────
export const spotPrice = signal<number | null>(null);
export const change24h = signal<number | null>(null);
export const streaming = signal(false);

// ── Live tick buffers (mutated imperatively; `ticksVersion` makes reads
//    reactive without copying the buffers into signals every tick). ────────
const LIVE_WINDOW_MS = 60_000;
export const liveTicks: PricePoint[] = [];
export const liveTicksByCrypto = new Map<CryptoId, PricePoint[]>();
export const ticksVersion = signal(0);

/** Eased right-edge price for the hero chart; read imperatively by the rAF loop. */
export const heroEdge: { last: number | null; display: number | null } = {
  last: null,
  display: null,
};

const isAll = () => selectedCrypto.value === 'all';

function resetForSwitch() {
  latest.value = null;
  latestAll.value = null;
  liveTicks.length = 0;
  heroEdge.last = null;
  heroEdge.display = null;
  spotPrice.value = null;
  change24h.value = null;
  streaming.value = false;
  loading.value = true;
}

// ── Polling ────────────────────────────────────────────────────────────────
let inflight = false;
export async function refresh() {
  if (inflight) return;
  inflight = true;
  // The selector may change mid-flight — only apply results that still match.
  const want = selectedCrypto.value;
  try {
    if (want === 'all') {
      const res = await fetch('/api/overview');
      if (!res.ok) throw new Error(`overview ${res.status}`);
      const data = (await res.json()) as { predictions: Prediction[] };
      if (selectedCrypto.value === 'all') {
        latestAll.value = data.predictions;
        const newest = data.predictions
          .map(p => p.asOf)
          .sort()
          .pop();
        if (newest) updatedAt.value = new Date(newest).toLocaleTimeString();
        loading.value = false;
      }
    } else {
      const res = await fetch(`/api/predict?crypto=${want}`);
      if (!res.ok) throw new Error(`predict ${res.status}`);
      const p = (await res.json()) as Prediction;
      if (selectedCrypto.value === want) {
        latest.value = p;
        // Once the stream owns the header, don't snap the (cached) predict price
        // backwards over it.
        if (!streaming.value) {
          spotPrice.value = p.stats.price;
          change24h.value = p.stats.change24hPct;
        }
        updatedAt.value = new Date(p.asOf).toLocaleTimeString();
        loading.value = false;
      }
    }
    errorMsg.value = '';
  } catch (err) {
    errorMsg.value = `Failed to load: ${String(err)}`;
  } finally {
    inflight = false;
  }
}

/** Window end times currently on screen, for expiry-triggered refetches. */
function visibleWindowEnds(): number[] {
  const ends: number[] = [];
  const push = (iso: string) => {
    const t = Date.parse(iso);
    if (Number.isFinite(t)) ends.push(t);
  };
  if (isAll()) {
    for (const p of latestAll.value ?? [])
      for (const r of p.ranges) push(r.windowEnd);
  } else {
    for (const r of latest.value?.ranges ?? []) push(r.windowEnd);
  }
  return ends;
}

// ── Live spot price stream (SSE) ─────────────────────────────────────────
function applyTick(tick: PriceTick) {
  const tickCrypto = tick.crypto ?? 'btc';

  const buf = liveTicksByCrypto.get(tickCrypto) ?? [];
  buf.push({ t: tick.t, price: tick.price });
  const bufCutoff = tick.t - LIVE_WINDOW_MS;
  while (buf.length > 2 && buf[0]!.t < bufCutoff) buf.shift();
  liveTicksByCrypto.set(tickCrypto, buf);
  ticksVersion.value++;

  if (isAll()) return;

  // Single-asset mode: only the focused crypto's ticks drive the header/chart.
  if (tickCrypto !== selectedCrypto.value) return;
  streaming.value = true;
  spotPrice.value = tick.price;
  change24h.value = tick.change24hPct;
  heroEdge.last = tick.price;

  liveTicks.push({ t: tick.t, price: tick.price });
  const cutoff = tick.t - LIVE_WINDOW_MS;
  while (liveTicks.length > 2 && liveTicks[0]!.t < cutoff) liveTicks.shift();
}

function connectPriceStream() {
  // EventSource auto-reconnects on transient drops; the server seeds the latest
  // tick on connect so a reconnect repaints immediately.
  const es = new EventSource('/api/price/stream');
  es.onmessage = ev => {
    try {
      applyTick(JSON.parse(ev.data) as PriceTick);
    } catch {
      // ignore malformed frames
    }
  };
}

async function refreshLiveTradingBadge() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) throw new Error(`trades ${res.status}`);
    const data = (await res.json()) as TradesResponse;
    liveTrading.value = data.enabled && !data.dryRun;
  } catch {
    // Keep last known state on transient failures.
  }
}

/** Wire up all the live page's side effects. Called once after the first render. */
export function startLive() {
  // Re-fetch (and clear stale data) whenever the asset changes.
  let prevCrypto = selectedCrypto.value;
  effect(() => {
    const c = selectedCrypto.value;
    if (c !== prevCrypto) {
      prevCrypto = c;
      resetForSwitch();
    }
    void refresh();
  });

  setInterval(() => void refresh(), 1_000);

  // Countdown clock: bump `now`, and if any on-screen window has closed, fetch
  // right away instead of waiting out the poll (refresh is inflight-guarded).
  setInterval(() => {
    const t = Date.now();
    now.value = t;
    if (visibleWindowEnds().some(end => end - t <= 0)) void refresh();
  }, 1_000);

  connectPriceStream();
  void refreshLiveTradingBadge();
  setInterval(() => void refreshLiveTradingBadge(), 30_000);
}
