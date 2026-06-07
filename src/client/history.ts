import type {
  InsightSnapshot,
  LedgerEntry,
  LedgerSummary,
  RangeId,
} from '../shared/types.ts';
import {
  $,
  COLORS,
  escapeHtml,
  fmtDateTime,
  fmtDay,
  fmtPct,
  fmtUsd,
  fmtUsd2,
  px,
} from './format.ts';

// ── Previous reads (windowed in-memory insight history) ──────────────────

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
      renderHitRateChart();
    });
  }
}

// ── Hit rate over time (accuracy-over-time line chart) ───────────────────
// Rolling window (in resolved calls) for the recent-form line.
const ROLL_N = 25;

/** Resolved entries for the active filter, oldest → newest. */
function resolvedForChart(): LedgerEntry[] {
  return ledgerEntries
    .filter(
      e =>
        e.outcome != null &&
        (recordFilter === 'ALL' || e.rangeId === recordFilter)
    )
    .sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));
}

/**
 * Inline SVG line chart of accuracy over time: a cumulative hit rate (overall
 * trend) and a rolling hit rate (recent form), against a dashed 50% baseline.
 * Drawn in a 0..100 viewBox stretched to fill the card.
 */
function hitRateChart(entries: LedgerEntry[]): string {
  if (entries.length < 2) return '<div class="chart-empty"></div>';

  let correct = 0;
  const pts = entries.map((e, i) => {
    if (e.correct) correct++;
    const cum = correct / (i + 1);
    const from = Math.max(0, i - ROLL_N + 1);
    let rollCorrect = 0;
    for (let j = from; j <= i; j++) if (entries[j]!.correct) rollCorrect++;
    const roll = rollCorrect / (i - from + 1);
    return { cum, roll };
  });

  // X is the resolved-call sequence (evenly spaced), so bursts of backfilled
  // calls don't bunch the line — each call is one step along the track record.
  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  const lastIdx = pts.length - 1 || 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (a: number) => PADTOP + (1 - a) * (H - PADTOP - PADBOT);

  const line = (key: 'cum' | 'roll') =>
    pts
      .map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`)
      .join(' ');

  const yMid = px(Y(0.5));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yMid}" x2="${W}" y2="${yMid}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line('cum')}" fill="none" stroke="${COLORS.muted}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" vector-effect="non-scaling-stroke"/>
    <path d="${line('roll')}" fill="none" stroke="${COLORS.accent}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderHitRateChart() {
  const entries = resolvedForChart();
  $('hr-chart').innerHTML = hitRateChart(entries);

  const axis = $('hr-axis');
  if (entries.length >= 2) {
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;
    axis.innerHTML =
      `<span>${fmtDay(Date.parse(first.windowStart))}</span>` +
      `<span class="hl">100% / 50% / 0%</span>` +
      `<span>${fmtDay(Date.parse(last.windowStart))}</span>`;
  } else {
    axis.innerHTML = '<span>Not enough resolved calls to chart yet.</span>';
  }

  $('hr-legend').innerHTML = `
    <span class="key"><span class="swatch" style="background:${COLORS.accent}"></span>Recent form (last ${ROLL_N})</span>
    <span class="key"><span class="swatch" style="background:${COLORS.muted}"></span>Cumulative</span>
    <span class="key"><span class="swatch dashed"></span>50% baseline</span>`;
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
    renderHitRateChart();
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
