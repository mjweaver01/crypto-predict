// Reactive state + polling for the history page. Two independent time controls:
// the record FILTER (which bet family: 5m/15m/…) and the DATE RANGE (the "over
// time" window: 24h/7d/30d/90d/all). The ledger is paginated server-side; the
// hit-rate + learning charts read the date-filtered metrics series.

import { computed, effect, signal } from '@preact/signals';
import type {
  InsightSnapshot,
  LedgerEntry,
  LedgerPagination,
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

// ── Pagination ─────────────────────────────────────────────────────────────
const PAGE_SIZE = 100;
export const recordPage = signal(1);
export const recordPagination = signal<LedgerPagination | null>(null);

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

/** crypto + date range (metrics, paper). */
const dateQS = (): string => {
  const parts: string[] = [];
  if (selectedCrypto.value !== 'all') parts.push(`crypto=${selectedCrypto.value}`);
  const from = dateFrom();
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

/** crypto + date range + pagination (ledger). */
const ledgerQS = (): string => {
  const parts: string[] = [];
  if (selectedCrypto.value !== 'all') parts.push(`crypto=${selectedCrypto.value}`);
  const from = dateFrom();
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  parts.push(`page=${recordPage.value}`, `pageSize=${PAGE_SIZE}`);
  return `?${parts.join('&')}`;
};

async function refreshHistory() {
  try {
    const res = await fetch(`/api/insights${cryptoQS()}`);
    if (!res.ok) return;
    const data = (await res.json()) as { entries: InsightSnapshot[] };
    insights.value = data.entries;
  } catch {
    // best-effort
  }
}

export async function refreshRecord() {
  try {
    const res = await fetch(`/api/ledger${ledgerQS()}`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      summary: LedgerSummary;
      filteredSummary: LedgerSummary;
      entries: LedgerEntry[];
      pagination: LedgerPagination;
    };
    ledgerEntries.value = data.entries;
    ledgerSummary.value = data.summary;
    ledgerFilteredSummary.value = data.filteredSummary;
    recordPagination.value = data.pagination;
    updatedAt.value = new Date().toLocaleTimeString();
    loading.value = false;
  } catch {
    // best-effort
  }
}

async function refreshMetrics() {
  try {
    const res = await fetch(`/api/metrics${dateQS()}`);
    if (!res.ok) return;
    metrics.value = (await res.json()) as MetricsResponse;
  } catch {
    // best-effort
  }
}

async function refreshPaper() {
  try {
    const res = await fetch(`/api/paper${dateQS()}`);
    if (!res.ok) return;
    paper.value = (await res.json()) as PaperResponse;
  } catch {
    // best-effort
  }
}

async function refreshLiveTrades() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) return;
    const data = (await res.json()) as TradesResponse;
    liveTrades.value = data.trades;
  } catch {
    // best-effort
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

/** Jump to a record page (clamped) and refetch just the ledger. */
export function goToPage(page: number) {
  const p = recordPagination.value;
  const totalPages = p ? Math.ceil(p.total / p.pageSize) : 1;
  const next = Math.min(Math.max(1, page), Math.max(1, totalPages));
  if (next === recordPage.value) return;
  recordPage.value = next;
  loading.value = true;
  void refreshRecord();
}

const refreshAll = () => {
  void refreshHistory();
  void refreshRecord();
  void refreshMetrics();
  void refreshPaper();
  void refreshLiveTrades();
};

export function startHistory() {
  // Re-fetch everything whenever the asset OR the date window changes (both
  // reset pagination to page 1).
  let prevCrypto = selectedCrypto.value;
  let prevPreset = datePreset.value;
  effect(() => {
    const c = selectedCrypto.value;
    const dp = datePreset.value;
    if (c !== prevCrypto || dp !== prevPreset) {
      prevCrypto = c;
      prevPreset = dp;
      recordPage.value = 1;
      loading.value = true;
    }
    refreshAll();
  });

  // Changing the family filter resets to page 1; the data is already in hand
  // (metrics covers all families, the list filters client-side), so no refetch.
  let prevFilter = recordFilter.value;
  effect(() => {
    const f = recordFilter.value;
    if (f !== prevFilter) {
      prevFilter = f;
      recordPage.value = 1;
    }
  });

  setInterval(() => void refreshHistory(), 5_000);
  setInterval(() => void refreshRecord(), 30_000);
  setInterval(() => void refreshMetrics(), 30_000);
  setInterval(() => void refreshPaper(), 30_000);
  setInterval(() => void refreshLiveTrades(), 30_000);
}
