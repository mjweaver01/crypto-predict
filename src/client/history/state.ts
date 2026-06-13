// Reactive state + polling for the history page. Two independent time controls:
// the record FILTER (which bet family: 5m/15m/…) and the DATE RANGE (the "over
// time" window: 24h/7d/30d/90d/all). The ledger is paginated server-side; the
// hit-rate + learning charts read the date-filtered metrics series.

import { computed, effect, signal } from '@preact/signals';
import type {
  InsightSnapshot,
  LedgerEntry,
  LedgerSummary,
  MetricsResponse,
  PaperBet,
  PaperResponse,
  RangeId,
  TradeRecord,
  TradesResponse,
} from '../../shared/types.ts';
import { loadPref, savePref } from '../format.ts';
import { selectedCrypto } from '../crypto.ts';

export const RECORD_RANGES: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];
export type RecordFilter = 'ALL' | RangeId;

// ── Date range ("over time" window) ───────────────────────────────────────
export type DatePreset = '1d' | '7d' | '30d' | '90d' | 'all';
export const DATE_PRESETS: readonly DatePreset[] = ['1d', '7d', '30d', '90d', 'all'];
export const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '1d': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  all: 'All time',
};
const DATE_PRESET_MS: Record<DatePreset, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  all: 0,
};
export const datePreset = signal<DatePreset>(
  loadPref('datePreset', DATE_PRESETS, '30d')
);
effect(() => savePref('datePreset', datePreset.value));

/** ISO string for the start of the active date window (undefined = no limit). */
const dateFrom = (): string | undefined => {
  if (datePreset.value === 'all') return undefined;
  return new Date(Date.now() - DATE_PRESET_MS[datePreset.value]).toISOString();
};

// ── Record filter (which bet family) ──────────────────────────────────────
export const recordFilter = signal<RecordFilter>(
  loadPref('filter', ['ALL', ...RECORD_RANGES] as const, 'ALL')
);
effect(() => savePref('filter', recordFilter.value));

// ── Server data ──────────────────────────────────────────────────────────
export const insights = signal<InsightSnapshot[]>([]);
export const ledgerEntries = signal<LedgerEntry[]>([]);
/** All-time stats (crypto-filtered). Drives the family filter badges. */
export const ledgerSummary = signal<LedgerSummary | null>(null);
/** Date-window stats. Drives the hit-rate headline. */
export const ledgerFilteredSummary = signal<LedgerSummary | null>(null);
export const metrics = signal<MetricsResponse | null>(null);
export const paper = signal<PaperResponse | null>(null);
export const liveTrades = signal<TradeRecord[]>([]);
export const updatedAt = signal('');
export const loading = signal(true);

export const paperById = computed(() => {
  const p = paper.value;
  const m = new Map<string, PaperBet>();
  if (p) for (const b of [...p.bets, ...p.open]) m.set(b.id, b);
  return m;
});

// ── Query-string builders ──────────────────────────────────────────────────
/** crypto only (insights has no date filter). */
const cryptoQS = () =>
  selectedCrypto.value === 'all' ? '' : `?crypto=${selectedCrypto.value}`;

/** crypto + date range (ledger, metrics, paper). */
const dateQS = (): string => {
  const parts: string[] = [];
  if (selectedCrypto.value !== 'all') parts.push(`crypto=${selectedCrypto.value}`);
  const from = dateFrom();
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

// Per-function abort controllers so that a new call (whether from a date/crypto
// change or a background interval) cancels any still-in-flight request for that
// same endpoint — preventing request pile-ups on the server.
let acHistory: AbortController | null = null;
let acRecord: AbortController | null = null;
let acMetrics: AbortController | null = null;
let acPaper: AbortController | null = null;
let acTrades: AbortController | null = null;

const isAbort = (err: unknown) => (err as { name?: string }).name === 'AbortError';

async function refreshHistory() {
  acHistory?.abort();
  acHistory = new AbortController();
  const { signal } = acHistory;
  try {
    const res = await fetch(`/api/insights${cryptoQS()}`, { signal });
    if (!res.ok) return;
    const data = (await res.json()) as { entries: InsightSnapshot[] };
    insights.value = data.entries;
  } catch (err) {
    if (!isAbort(err)) { /* best-effort */ }
  }
}

export async function refreshRecord() {
  acRecord?.abort();
  acRecord = new AbortController();
  const { signal } = acRecord;
  try {
    const res = await fetch(`/api/ledger${dateQS()}`, { signal });
    if (!res.ok) return;
    const data = (await res.json()) as {
      summary: LedgerSummary;
      filteredSummary: LedgerSummary;
      entries: LedgerEntry[];
    };
    ledgerEntries.value = data.entries;
    ledgerSummary.value = data.summary;
    ledgerFilteredSummary.value = data.filteredSummary;
    updatedAt.value = new Date().toLocaleTimeString();
    loading.value = false;
  } catch (err) {
    if (!isAbort(err)) { /* best-effort */ }
  }
}

async function refreshMetrics() {
  acMetrics?.abort();
  acMetrics = new AbortController();
  const { signal } = acMetrics;
  try {
    const res = await fetch(`/api/metrics${dateQS()}`, { signal });
    if (!res.ok) return;
    metrics.value = (await res.json()) as MetricsResponse;
  } catch (err) {
    if (!isAbort(err)) { /* best-effort */ }
  }
}

async function refreshPaper() {
  acPaper?.abort();
  acPaper = new AbortController();
  const { signal } = acPaper;
  try {
    const res = await fetch(`/api/paper${dateQS()}`, { signal });
    if (!res.ok) return;
    paper.value = (await res.json()) as PaperResponse;
  } catch (err) {
    if (!isAbort(err)) { /* best-effort */ }
  }
}

async function refreshLiveTrades() {
  acTrades?.abort();
  acTrades = new AbortController();
  const { signal } = acTrades;
  try {
    const res = await fetch('/api/trades', { signal });
    if (!res.ok) return;
    const data = (await res.json()) as TradesResponse;
    liveTrades.value = data.trades;
  } catch (err) {
    if (!isAbort(err)) { /* best-effort */ }
  }
}

export async function verifyFills(): Promise<Record<string, number>> {
  const res = await fetch('/api/trades/verify', { method: 'POST' });
  if (!res.ok) throw new Error(`server ${res.status}`);
  const data = (await res.json()) as {
    counts: Record<string, number>;
    trades: TradeRecord[];
  };
  liveTrades.value = data.trades;
  return data.counts;
}

const refreshAll = () => {
  void refreshHistory();
  void refreshRecord();
  void refreshMetrics();
  void refreshPaper();
  void refreshLiveTrades();
};

export function startHistory() {
  // Re-fetch everything whenever the asset OR the date window changes.
  let prevCrypto = selectedCrypto.value;
  let prevPreset = datePreset.value;
  effect(() => {
    const c = selectedCrypto.value;
    const dp = datePreset.value;
    if (c !== prevCrypto || dp !== prevPreset) {
      prevCrypto = c;
      prevPreset = dp;
      loading.value = true;
    }
    refreshAll();
  });

  setInterval(() => void refreshHistory(), 5_000);
  setInterval(() => void refreshRecord(), 30_000);
  setInterval(() => void refreshMetrics(), 30_000);
  setInterval(() => void refreshPaper(), 30_000);
  setInterval(() => void refreshLiveTrades(), 30_000);
}
