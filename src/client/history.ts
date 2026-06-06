import type {
  InsightSnapshot,
  LedgerEntry,
  LedgerSummary,
  RangeId,
} from '../shared/types.ts';
import { $, escapeHtml, fmtDateTime, fmtPct, fmtUsd, fmtUsd2 } from './format.ts';

// ── Previous reads (windowed in-memory insight history) ──────────────────
let historyOpen = true;

function renderHistory(entries: InsightSnapshot[]) {
  const list = $('history-list');
  const empty = $('history-empty');
  empty.style.display = entries.length ? 'none' : 'block';
  list.innerHTML = entries
    .map(e => {
      const method = e.llmApplied
        ? '<span class="hist-method llm">LLM</span>'
        : '<span class="hist-method stats">Stats</span>';
      const change = `${e.change24hPct >= 0 ? '+' : ''}${e.change24hPct.toFixed(2)}%`;
      const reasoning = e.reasoning
        ? `<div class="hist-reasoning">${escapeHtml(e.reasoning)}</div>`
        : '';
      const calls = e.calls
        .map(
          c =>
            `<span class="hist-call ${c.side === 'UP' ? 'up' : 'down'}">${c.label} ${c.side} ${fmtPct(c.probUp)}</span>`
        )
        .join('');
      return `<div class="hist">
        <div class="hist-top">
          <span class="hist-time">${new Date(e.asOf).toLocaleTimeString()}</span>
          ${method}
          <span>${fmtUsd(e.price)} · ${change} 24h</span>
        </div>
        <div class="hist-narrative">${escapeHtml(e.narrative)}</div>
        ${reasoning}
        <div class="hist-calls">${calls}</div>
      </div>`;
    })
    .join('');
}

async function refreshHistory() {
  try {
    const res = await fetch('/api/insights');
    if (!res.ok) return;
    const data = (await res.json()) as { entries: InsightSnapshot[] };
    renderHistory(data.entries);
  } catch {
    // History is best-effort; ignore transient failures.
  }
}

$('history-toggle').addEventListener('click', () => {
  historyOpen = !historyOpen;
  $('history-list').classList.toggle('collapsed', !historyOpen);
  $('history-toggle').textContent = historyOpen ? 'Hide' : 'Show';
});

// ── Track record (persisted calls vs realized outcomes) ──────────────────
const RECORD_RANGES: RangeId[] = ['5m', '15m', '1h', '1d'];
type RecordFilter = 'ALL' | RangeId;
let recordFilter: RecordFilter = 'ALL';
let ledgerEntries: LedgerEntry[] = [];
let ledgerSummary: LedgerSummary | null = null;

function renderRecordSummary() {
  const s = ledgerSummary;
  if (!s) return;
  $('rec-sub').textContent =
    `${s.resolved} resolved of ${s.total} calls · ${s.correct} correct`;
  $('rec-stats').innerHTML = `
    <div>
      <div class="rstat-label">Hit rate</div>
      <div class="rstat-val accent">${s.resolved ? fmtPct(s.accuracy) : '—'}</div>
    </div>
    <div>
      <div class="rstat-label">Brier</div>
      <div class="rstat-val">${s.resolved ? s.brier.toFixed(3) : '—'}</div>
    </div>`;
}

function renderRecordFilters() {
  const s = ledgerSummary;
  const el = $('rec-filters');
  const tab = (id: RecordFilter, label: string, acc: string) =>
    `<button data-rf="${id}" class="${id === recordFilter ? 'active' : ''}">${label}<span class="rf-acc">${acc}</span></button>`;
  const overall = s && s.resolved ? fmtPct(s.accuracy) : '—';
  el.innerHTML =
    tab('ALL', 'All', overall) +
    RECORD_RANGES.map(id => {
      const r = s?.byRange[id];
      const acc = r && r.resolved ? fmtPct(r.accuracy) : '—';
      return tab(id, id, acc);
    }).join('');
  for (const btn of el.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      recordFilter = btn.dataset.rf as RecordFilter;
      renderRecordFilters();
      renderRecordList();
    });
  }
}

function recordRow(e: LedgerEntry): string {
  const sideCls = e.side === 'UP' ? 'up' : 'down';
  let result: string;
  if (e.outcome == null) {
    result = '<span class="rec-result pending" title="Awaiting resolution">···</span>';
  } else if (e.correct) {
    result = '<span class="rec-result hit" title="Correct">✓</span>';
  } else {
    result = '<span class="rec-result miss" title="Incorrect">✗</span>';
  }

  const outcome =
    e.outcome == null
      ? '<span class="rec-arrow">→ pending</span>'
      : `<span class="rec-arrow">→</span><span class="rec-side ${e.outcome === 'UP' ? 'up' : 'down'}">${e.outcome}</span>`;

  const closeBits =
    e.closePrice != null ? ` · closed ${fmtUsd2(e.closePrice)}` : '';

  return `<div class="rec">
    ${result}
    <span class="rec-range">${e.rangeId}</span>
    <div class="rec-main">
      <span class="rec-when">${fmtDateTime(e.windowStart)}</span>
      <div class="rec-calls">
        called <span class="rec-side ${sideCls}">${e.side}</span>
        ${outcome}
        <span>· vs ${fmtUsd2(e.strike)}${closeBits}</span>
      </div>
    </div>
    <div class="rec-prob">
      ${fmtPct(e.confidence)}
      <div class="rec-prob-sub">conf</div>
    </div>
  </div>`;
}

function renderRecordList() {
  const list = $('rec-list');
  const empty = $('rec-empty');
  const filtered =
    recordFilter === 'ALL'
      ? ledgerEntries
      : ledgerEntries.filter(e => e.rangeId === recordFilter);
  empty.style.display = filtered.length ? 'none' : 'block';
  empty.textContent = ledgerEntries.length
    ? 'No calls for this range yet.'
    : 'No resolved calls yet.';
  list.innerHTML = filtered.map(recordRow).join('');
}

async function refreshRecord() {
  try {
    const res = await fetch('/api/ledger');
    if (!res.ok) return;
    const data = (await res.json()) as {
      summary: LedgerSummary;
      entries: LedgerEntry[];
    };
    ledgerEntries = data.entries;
    ledgerSummary = data.summary;
    renderRecordSummary();
    renderRecordFilters();
    renderRecordList();
    $('updated').textContent = new Date().toLocaleTimeString();
    $('app').classList.remove('loading');
  } catch {
    // Track record is best-effort; ignore transient failures.
  }
}

refreshHistory();
setInterval(refreshHistory, 5_000);
// The ledger only changes when windows resolve (server resolve loop ≈ 60s), so
// poll it on a slower cadence than the in-memory insights.
refreshRecord();
setInterval(refreshRecord, 30_000);
