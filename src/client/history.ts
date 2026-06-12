import type {
  FamilyMetrics,
  InsightSnapshot,
  LedgerEntry,
  LedgerPagination,
  LedgerSummary,
  MetricsPoint,
  MetricsResponse,
  PaperBet,
  PaperResponse,
  RangeId,
  TradeRecord,
  TradesResponse,
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
  loadPref,
  px,
  savePref,
} from './format.ts';
import { attachChartTip } from './chartTip.ts';
import { CRYPTOS, CRYPTO_IDS, type CryptoId } from '../shared/cryptos.ts';

// ── Crypto filter (shared pref with the live page) ────────────────────────
type CryptoChoice = CryptoId | 'all';
const CRYPTO_CHOICES: readonly CryptoChoice[] = [...CRYPTO_IDS, 'all'];
let selectedCrypto: CryptoChoice = loadPref('crypto', CRYPTO_CHOICES, 'btc');

/** @deprecated use dateQS() or ledgerQS() — kept only for /api/insights which has no date filter yet */
const cryptoQS = () =>
  selectedCrypto === 'all' ? '' : `?crypto=${selectedCrypto}`;

function wireCryptoSelect(onChange: () => void) {
  const sel = $<HTMLSelectElement>('crypto-select');
  sel.innerHTML =
    `<option value="all">All cryptos</option>` +
    CRYPTO_IDS.map(
      id =>
        `<option value="${id}">${CRYPTOS[id].label} (${CRYPTOS[id].ticker})</option>`
    ).join('');
  sel.value = selectedCrypto;
  sel.addEventListener('change', () => {
    selectedCrypto = sel.value as CryptoChoice;
    savePref('crypto', selectedCrypto);
    recordPage = 1;
    $('app').classList.add('loading');
    onChange();
  });
}

/** X positions (viewBox %) for n evenly spaced points, matching the charts'
 *  PADX=1.5 layout, so tooltip snapping lands exactly on the drawn points. */
const seriesXs = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => 1.5 + (i / Math.max(1, n - 1)) * 97);

const isoOf = (t: number) => new Date(t).toISOString();

// ── Previous reads (windowed insight history) ─────────────────────────────

function renderHistory(entries: InsightSnapshot[]) {
  const list = $('history-list');
  const empty = $('history-empty');
  empty.style.display = entries.length ? 'none' : 'block';
  list.innerHTML = entries
    .map(e => {
      // The asset chip replaces the old LLM/Stats method tag — every read is
      // stats-grounded now, and in the All filter the asset is what matters.
      const ticker = CRYPTOS[e.crypto ?? 'btc']?.ticker ?? 'BTC';
      const change = `${e.change24hPct >= 0 ? '+' : ''}${e.change24hPct.toFixed(2)}%`;
      const calls = e.calls
        .map(
          c =>
            `<span class="hist-call ${c.side === 'UP' ? 'up' : 'down'}">${c.label} ${c.side} ${fmtPct(c.probUp)}</span>`
        )
        .join('');
      return `<div class="hist">
        <div class="hist-top">
          <span class="hist-time">${new Date(e.asOf).toLocaleTimeString()}</span>
          <span class="hist-method stats">${ticker}</span>
          <span>${fmtUsd(e.price)} · ${change} 24h</span>
        </div>
        <div class="hist-narrative">${escapeHtml(e.narrative)}</div>
        <div class="hist-calls">${calls}</div>
      </div>`;
    })
    .join('');
}

async function refreshHistory() {
  try {
    const res = await fetch(`/api/insights${cryptoQS()}`);
    if (!res.ok) return;
    const data = (await res.json()) as { entries: InsightSnapshot[] };
    renderHistory(data.entries);
  } catch {
    // History is best-effort; ignore transient failures.
  }
}

// ── Date range filter ─────────────────────────────────────────────────────
type DatePreset = '1d' | '7d' | '30d' | '90d' | 'all';
const DATE_PRESETS: readonly DatePreset[] = ['1d', '7d', '30d', '90d', 'all'];
const DATE_PRESET_LABELS: Record<DatePreset, string> = {
  '1d': '24h',
  '7d': '7d',
  '30d': '30d',
  '90d': '90d',
  'all': 'All time',
};
const DATE_PRESET_MS: Record<DatePreset, number> = {
  '1d': 86_400_000,
  '7d': 7 * 86_400_000,
  '30d': 30 * 86_400_000,
  '90d': 90 * 86_400_000,
  'all': 0,
};
let datePreset: DatePreset = loadPref('datePreset', DATE_PRESETS, '30d');

/** ISO string for the start of the active date window (undefined = no limit). */
const dateFrom = (): string | undefined => {
  if (datePreset === 'all') return undefined;
  return new Date(Date.now() - DATE_PRESET_MS[datePreset]).toISOString();
};

/**
 * Query-string for endpoints that accept crypto + date range but NOT pagination
 * (metrics, paper).
 */
const dateQS = (): string => {
  const parts: string[] = [];
  if (selectedCrypto !== 'all') parts.push(`crypto=${selectedCrypto}`);
  const from = dateFrom();
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

// ── Track record (persisted calls vs realized outcomes) ──────────────────
const RECORD_RANGES: RangeId[] = ['5m', '15m', '1h', '4h', '1d'];
type RecordFilter = 'ALL' | RangeId;
let recordFilter: RecordFilter = loadPref(
  'filter',
  ['ALL', ...RECORD_RANGES] as const,
  'ALL'
);
let ledgerEntries: LedgerEntry[] = [];
/** All-time stats (crypto-filtered). Shown in the range filter tab badges. */
let ledgerSummary: LedgerSummary | null = null;
/** Date-window stats. Shown in the hit-rate headline card. */
let ledgerFilteredSummary: LedgerSummary | null = null;

// ── Pagination state ──────────────────────────────────────────────────────
const PAGE_SIZE = 100;
let recordPage = 1;
let recordPagination: LedgerPagination | null = null;

function renderRecordSummary() {
  // Headline stats reflect the active date window; all-time shown as context.
  const s = ledgerFilteredSummary ?? ledgerSummary;
  const all = ledgerSummary;
  if (!s) return;
  const windowLabel =
    datePreset === 'all' ? 'all time' : DATE_PRESET_LABELS[datePreset];
  $('rec-sub').textContent =
    `${s.resolved} resolved of ${s.total} calls · ${s.correct} correct · ${windowLabel}`;
  const allTimeSuffix =
    all && all !== s && all.resolved
      ? ` <span class="rstat-alltime">(${fmtPct(all.accuracy)} all time)</span>`
      : '';
  $('rec-stats').innerHTML = `
    <div>
      <div class="rstat-label">Hit rate</div>
      <div class="rstat-val accent">${s.resolved ? fmtPct(s.accuracy) : '—'}${allTimeSuffix}</div>
    </div>
    <div>
      <div class="rstat-label">Brier</div>
      <div class="rstat-val">${s.resolved ? s.brier.toFixed(3) : '—'}</div>
    </div>`;
}

function renderDateRange() {
  const el = $('date-range-bar');
  el.innerHTML = DATE_PRESETS.map(
    p =>
      `<button data-dp="${p}" class="${p === datePreset ? 'active' : ''}">${DATE_PRESET_LABELS[p]}</button>`
  ).join('');
  for (const btn of el.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      datePreset = btn.dataset.dp as DatePreset;
      savePref('datePreset', datePreset);
      recordPage = 1;
      $('app').classList.add('loading');
      refreshAll();
    });
  }
}

function renderRecordPagination() {
  const el = $('rec-pagination');
  const p = recordPagination;
  if (!p || p.total === 0) {
    el.innerHTML = '';
    return;
  }
  const totalPages = Math.ceil(p.total / p.pageSize);
  if (totalPages <= 1) {
    el.innerHTML = `<span class="rec-page-info">${p.total} entries</span>`;
    return;
  }
  const from = (p.page - 1) * p.pageSize + 1;
  const to = Math.min(p.page * p.pageSize, p.total);
  el.innerHTML =
    `<button class="rec-page-btn" id="rec-prev" ${p.page <= 1 ? 'disabled' : ''}>← Prev</button>` +
    `<span class="rec-page-info">${from}–${to} of ${p.total}</span>` +
    `<button class="rec-page-btn" id="rec-next" ${p.page >= totalPages ? 'disabled' : ''}>Next →</button>`;
  el.querySelector('#rec-prev')?.addEventListener('click', () => {
    if (recordPage > 1) {
      recordPage--;
      $('app').classList.add('loading');
      refreshRecord();
    }
  });
  el.querySelector('#rec-next')?.addEventListener('click', () => {
    if (recordPage < totalPages) {
      recordPage++;
      $('app').classList.add('loading');
      refreshRecord();
    }
  });
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
      savePref('filter', recordFilter);
      recordPage = 1;
      renderRecordFilters();
      renderRecordList();
      renderHitRateChart();
      renderLearningCurve();
      renderPaper();
    });
  }
}

// ── Learning curve (prequential Brier: learned layer vs raw vs market) ────
let metrics: MetricsResponse | null = null;

function activeFamilyMetrics(): FamilyMetrics | undefined {
  return metrics?.families.find(f => f.family === recordFilter);
}

/**
 * Rolling Brier of the calibrated (bet-on) probability vs the frozen raw
 * model probability, against the 0.25 coin-flip baseline. The gap between the
 * two lines is the learned layer's real out-of-sample contribution.
 */
function learningChart(f: FamilyMetrics): string {
  const pts = f.series;
  if (pts.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  // Y spans the data plus the 0.25 baseline so the dashed line is always shown.
  const vals = pts.flatMap(p => [p.brierCal, p.brierRaw]).concat(0.25);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = Math.max(hi - lo, 0.02);
  const lastIdx = pts.length - 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (v: number) =>
    PADTOP + (1 - (v - lo) / span) * (H - PADTOP - PADBOT);

  const line = (key: 'brierCal' | 'brierRaw') =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`).join(' ');

  const yBase = px(Y(0.25));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yBase}" x2="${W}" y2="${yBase}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line('brierRaw')}" fill="none" stroke="${COLORS.muted}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" vector-effect="non-scaling-stroke"/>
    <path d="${line('brierCal')}" fill="none" stroke="${COLORS.accent}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderLearningCurve() {
  const f = activeFamilyMetrics();
  const chart = $('lc-chart');
  const axis = $('lc-axis');
  const sub = $('lc-sub');
  const stats = $('lc-stats');
  if (!f || f.rolling.n === 0) {
    chart.innerHTML = '<div class="chart-empty"></div>';
    axis.innerHTML = '<span>Not enough resolved calls yet.</span>';
    sub.textContent = '—';
    stats.innerHTML = '';
    $('lc-legend').innerHTML = '';
    return;
  }

  const r = f.rolling;
  // Positive edge = the learned layer beats the raw model out-of-sample.
  const edge = r.brierRaw - r.brierCal;
  sub.textContent =
    `last ${r.n} resolved calls · ` +
    `learned edge ${edge >= 0 ? '+' : ''}${(edge * 1000).toFixed(1)} mBrier`;
  const mkt =
    r.brierMkt !== undefined
      ? `<div>
          <div class="rstat-label">Market (n=${r.nMkt})</div>
          <div class="rstat-val">${r.brierMkt.toFixed(3)}</div>
        </div>`
      : '';
  stats.innerHTML = `
    <div>
      <div class="rstat-label">Calibrated</div>
      <div class="rstat-val accent">${r.brierCal.toFixed(3)}</div>
    </div>
    <div>
      <div class="rstat-label">Raw model</div>
      <div class="rstat-val">${r.brierRaw.toFixed(3)}</div>
    </div>
    ${mkt}`;

  chart.innerHTML = learningChart(f);
  attachChartTip(chart, {
    xs: seriesXs(f.series.length),
    at: i => {
      const p = f.series[i]!;
      return {
        title: fmtDateTime(isoOf(p.t)),
        rows: [
          {
            label: 'Calibrated',
            value: p.brierCal.toFixed(3),
            color: COLORS.accent,
          },
          {
            label: 'Raw model',
            value: p.brierRaw.toFixed(3),
            color: COLORS.muted,
          },
          { label: 'Hit rate', value: fmtPct(p.accuracy) },
        ],
      };
    },
  });
  if (f.series.length >= 2) {
    const first = f.series[0]!;
    const last = f.series[f.series.length - 1]!;
    axis.innerHTML =
      `<span>${fmtDay(first.t)}</span>` +
      `<span class="hl">rolling ${f.window}-call Brier</span>` +
      `<span>${fmtDay(last.t)}</span>`;
  } else {
    axis.innerHTML = '<span>Not enough resolved calls to chart yet.</span>';
  }
  $('lc-legend').innerHTML = `
    <span class="key"><span class="swatch" style="background:${COLORS.accent}"></span>Calibrated (bet on)</span>
    <span class="key"><span class="swatch" style="background:${COLORS.muted}"></span>Raw model</span>
    <span class="key"><span class="swatch dashed"></span>0.25 coin-flip</span>`;
}

async function refreshMetrics() {
  try {
    const res = await fetch(`/api/metrics${dateQS()}`);
    if (!res.ok) return;
    metrics = (await res.json()) as MetricsResponse;
    renderHitRateChart();
    renderLearningCurve();
  } catch {
    // Learning curve is best-effort; ignore transient failures.
  }
}

// ── Paper trading (EV policy replayed at real order-book costs) ───────────
let paper: PaperResponse | null = null;
/** Resolved + open paper bets by ledger id, for joining money into rows. */
let paperById = new Map<string, PaperBet>();

/** Generic value-over-sequence line vs a dashed baseline (equity / cum P&L). */
function paperChart(values: number[], baseline: number): string {
  if (values.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  const all = values.concat(baseline);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = Math.max(hi - lo, 1e-9);
  const lastIdx = values.length - 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (v: number) =>
    PADTOP + (1 - (v - lo) / span) * (H - PADTOP - PADBOT);

  const line = values
    .map((v, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(v))}`)
    .join(' ');
  const yBase = px(Y(baseline));
  const color =
    values[values.length - 1]! >= baseline ? COLORS.up : COLORS.down;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yBase}" x2="${W}" y2="${yBase}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** One paper bet row: side + entry price, money staked, and the P&L. */
function paperBetRow(b: PaperBet): string {
  const result =
    b.pnl === undefined
      ? '<span class="rec-result pending" title="Awaiting resolution">···</span>'
      : b.won
        ? '<span class="rec-result hit" title="Won">✓</span>'
        : '<span class="rec-result miss" title="Lost">✗</span>';
  const pnl =
    b.pnl === undefined
      ? `<span class="pt-pnl">to win ${fmtUsd2((b.stake * (1 - b.cost)) / b.cost)}</span>`
      : `<span class="pt-pnl ${b.pnl >= 0 ? 'up' : 'down'}">${b.pnl >= 0 ? '+' : ''}${fmtUsd2(b.pnl)}</span>`;
  const bank =
    b.bankrollAfter !== undefined
      ? `<span class="pt-bank">bank ${fmtUsd2(b.bankrollAfter)}</span>`
      : '<span class="pt-bank">open</span>';
  return `<div class="pt-bet">
    ${result}
    <span class="rec-range">${b.rangeId}</span>
    <span class="pt-when">${fmtDateTime(b.decidedAt)}</span>
    <span class="rec-side ${b.side === 'UP' ? 'up' : 'down'}">${b.side}</span>
    <span class="pt-num">at ${(b.cost * 100).toFixed(1)}¢ (edge +${(b.edge * 100).toFixed(1)}¢)</span>
    <span class="pt-num">bet ${fmtUsd2(b.stake)}</span>
    ${pnl}
    ${bank}
  </div>`;
}

function renderPaper() {
  const p = paper;
  if (!p) return;
  const s = p.summary;
  const pol = p.policy;
  const sub = $('pt-sub');
  const stats = $('pt-stats');
  const chart = $('pt-chart');
  const axis = $('pt-axis');
  const legend = $('pt-legend');
  const betsEl = $('pt-bets');
  const famFilter = recordFilter !== 'ALL';
  const meTxt = famFilter
    ? `min edge ${(pol.minEdge[recordFilter as RangeId] * 100).toFixed(0)}¢`
    : `min edge ${RECORD_RANGES.map(id => (pol.minEdge[id] * 100).toFixed(0)).join('/')}¢ (${RECORD_RANGES.join('/')})`;
  const polTxt =
    `${meTxt} · ` +
    `${(pol.kellyFraction * 100).toFixed(0)}% Kelly, ≤${(pol.maxStakeFraction * 100).toFixed(0)}%/bet`;
  const bets = famFilter
    ? p.bets.filter(b => b.rangeId === recordFilter)
    : p.bets;
  const open = famFilter
    ? p.open.filter(b => b.rangeId === recordFilter)
    : p.open;

  if (bets.length === 0) {
    sub.textContent =
      `No resolved paper bets${famFilter ? ` for ${recordFilter}` : ''} yet · ` +
      `${open.length} open · ${polTxt} — accumulates as commits with real ` +
      'bid/ask resolve.';
    stats.innerHTML = '';
    chart.innerHTML = '<div class="chart-empty"></div>';
    axis.innerHTML = '';
    legend.innerHTML = '';
    betsEl.innerHTML = open.map(paperBetRow).join('');
    return;
  }

  if (famFilter) {
    // Per-family view: this family's bets in isolation. Bankroll is a global
    // (cross-family, compounding) quantity, so chart cumulative P&L instead.
    const f = p.families.find(x => x.rangeId === recordFilter);
    const wins = bets.filter(b => b.won).length;
    sub.textContent =
      `${recordFilter}: ${bets.length} bets (${wins}W–${bets.length - wins}L) · ` +
      `${open.length} open · ${polTxt}`;
    const pnl = f?.pnl ?? 0;
    const sign = pnl >= 0 ? '+' : '';
    stats.innerHTML = `
      <div>
        <div class="rstat-label">P&amp;L</div>
        <div class="rstat-val" style="color:${pnl >= 0 ? COLORS.up : COLORS.down}">${sign}${fmtUsd2(pnl)}</div>
      </div>
      <div>
        <div class="rstat-label">Staked</div>
        <div class="rstat-val">${fmtUsd2(f?.staked ?? 0)}</div>
      </div>
      <div>
        <div class="rstat-label">ROI</div>
        <div class="rstat-val">${fmtPct(f?.roi ?? 0)}</div>
      </div>
      <div>
        <div class="rstat-label">Win rate</div>
        <div class="rstat-val accent">${fmtPct(bets.length ? wins / bets.length : 0)}</div>
      </div>`;
    let cum = 0;
    const ordered = [...bets].reverse(); // oldest → newest
    const series = ordered.map(b => (cum += b.pnl ?? 0));
    chart.innerHTML = paperChart([0, ...series], 0);
    attachChartTip(chart, {
      xs: seriesXs(series.length + 1),
      at: i => {
        if (i === 0)
          return {
            title: 'start',
            rows: [{ label: 'Cumulative', value: fmtUsd2(0) }],
          };
        const b = ordered[i - 1]!;
        const pnl = b.pnl ?? 0;
        return {
          title: fmtDateTime(b.decidedAt),
          rows: [
            {
              label: `${b.side} at ${(b.cost * 100).toFixed(1)}¢, bet ${fmtUsd2(b.stake)}`,
              value: `${pnl >= 0 ? '+' : ''}${fmtUsd2(pnl)}`,
              color: pnl >= 0 ? COLORS.up : COLORS.down,
            },
            { label: 'Cumulative', value: fmtUsd2(series[i - 1]!) },
          ],
        };
      },
    });
    axis.innerHTML = `<span class="hl">cumulative ${recordFilter} P&L per resolved bet</span>`;
  } else {
    sub.textContent =
      `${s.bets} bets (${s.wins}W–${s.bets - s.wins}L) · ` +
      `${s.passes} passes · ${open.length} open · ` +
      `book: ${s.sources.live} live, ${s.sources.trades} backfilled · ${polTxt}`;
    const sign = s.pnl >= 0 ? '+' : '';
    stats.innerHTML = `
      <div>
        <div class="rstat-label">Bankroll</div>
        <div class="rstat-val accent">${fmtUsd2(s.bankroll)}</div>
      </div>
      <div>
        <div class="rstat-label">P&amp;L</div>
        <div class="rstat-val" style="color:${s.pnl >= 0 ? COLORS.up : COLORS.down}">${sign}${fmtUsd2(s.pnl)}</div>
      </div>
      <div>
        <div class="rstat-label">ROI</div>
        <div class="rstat-val">${fmtPct(s.roi)}</div>
      </div>
      <div>
        <div class="rstat-label">Max DD</div>
        <div class="rstat-val">${fmtPct(s.maxDrawdown)}</div>
      </div>`;
    chart.innerHTML = paperChart(
      p.equity.map(x => x.bankroll),
      pol.startBankroll
    );
    const orderedAll = [...p.bets].reverse(); // oldest → newest, matches equity
    // Build per-family running P&L + count series so the tooltip can show all
    // ranges at every equity point, not just the single bet that landed there.
    const famPnl: Record<string, number> = {};
    const famCount: Record<string, number> = {};
    const famPnlSeries: Array<Record<string, number>> = [];
    const famCountSeries: Array<Record<string, number>> = [];
    for (const b of orderedAll) {
      famPnl[b.rangeId] = (famPnl[b.rangeId] ?? 0) + (b.pnl ?? 0);
      famCount[b.rangeId] = (famCount[b.rangeId] ?? 0) + 1;
      famPnlSeries.push(Object.assign({}, famPnl));
      famCountSeries.push(Object.assign({}, famCount));
    }
    attachChartTip(chart, {
      xs: seriesXs(p.equity.length),
      at: i => {
        const e = p.equity[i]!;
        const b = orderedAll[i];
        const delta = e.bankroll - pol.startBankroll;
        const rows = [
          {
            label: 'Bankroll',
            value: fmtUsd2(e.bankroll),
            color: COLORS.accent,
          },
          {
            label: 'vs start',
            value: `${delta >= 0 ? '+' : ''}${fmtUsd2(delta)}`,
            color: delta >= 0 ? COLORS.up : COLORS.down,
          },
        ];
        if (b) {
          const pnl = b.pnl ?? 0;
          rows.push({
            label: `${b.rangeId} ${b.side} @ ${(b.cost * 100).toFixed(1)}¢  bet ${fmtUsd2(b.stake)}`,
            value: `${pnl >= 0 ? '+' : ''}${fmtUsd2(pnl)}`,
            color: pnl >= 0 ? COLORS.up : COLORS.down,
          });
        }
        // Per-family cumulative P&L up to this point.
        const snappedPnl = famPnlSeries[i] ?? {};
        const snappedCount = famCountSeries[i] ?? {};
        for (const id of RECORD_RANGES) {
          if ((snappedCount[id] ?? 0) > 0) {
            const cum = snappedPnl[id] ?? 0;
            rows.push({
              label: `${id} (${snappedCount[id]} bets)`,
              value: `${cum >= 0 ? '+' : ''}${fmtUsd2(cum)}`,
              color: cum >= 0 ? COLORS.up : COLORS.down,
            });
          }
        }
        return { title: fmtDateTime(isoOf(e.t)), rows };
      },
    });
    if (p.equity.length >= 2) {
      const first = p.equity[0]!;
      const last = p.equity[p.equity.length - 1]!;
      axis.innerHTML =
        `<span>${fmtDay(first.t)}</span>` +
        `<span class="hl">bankroll per resolved bet</span>` +
        `<span>${fmtDay(last.t)}</span>`;
    } else {
      axis.innerHTML = '<span>Not enough resolved bets to chart yet.</span>';
    }
  }

  legend.innerHTML = p.families
    .map(f => {
      const sgn = f.pnl >= 0 ? '+' : '';
      return `<span class="key"><span class="swatch" style="background:${
        f.pnl >= 0 ? COLORS.up : COLORS.down
      }"></span>${f.rangeId}: ${sgn}${fmtUsd2(f.pnl)} (${f.wins}/${f.bets}, roi ${fmtPct(f.roi)})</span>`;
    })
    .join('');

  // Open bets first (what's at stake now), then resolved, newest first.
  const MAX_ROWS = 30;
  const rows = [...open, ...bets].slice(0, MAX_ROWS);
  betsEl.innerHTML =
    rows.map(paperBetRow).join('') +
    (open.length + bets.length > MAX_ROWS
      ? `<div class="pt-more">showing ${MAX_ROWS} of ${open.length + bets.length} bets</div>`
      : '');
}

async function refreshPaper() {
  try {
    const res = await fetch(`/api/paper${dateQS()}`);
    if (!res.ok) return;
    paper = (await res.json()) as PaperResponse;
    paperById = new Map(
      [...paper.bets, ...paper.open].map(b => [b.id, b] as const)
    );
    renderPaper();
    renderRecordList(); // joins bet money into call-history rows
  } catch {
    // Paper scoreboard is best-effort; ignore transient failures.
  }
}

// ── Hit rate over time (accuracy-over-time line chart) ───────────────────
// Chart now reads from the metrics series (which is already date-filtered and
// covers the FULL window, not just the current ledger page).

function hitRateChartFromSeries(pts: MetricsPoint[]): string {
  if (pts.length < 2) return '<div class="chart-empty"></div>';

  const W = 100;
  const H = 100;
  const PADX = 1.5;
  const PADTOP = 8;
  const PADBOT = 8;
  const lastIdx = pts.length - 1 || 1;
  const X = (i: number) => PADX + (i / lastIdx) * (W - 2 * PADX);
  const Y = (a: number) => PADTOP + (1 - a) * (H - PADTOP - PADBOT);

  const line = (key: 'cumAccuracy' | 'accuracy') =>
    pts.map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`).join(' ');

  const yMid = px(Y(0.5));
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${yMid}" x2="${W}" y2="${yMid}" stroke="${COLORS.muted}" stroke-width="1" stroke-dasharray="3 3" opacity="0.4" vector-effect="non-scaling-stroke"/>
    <path d="${line('cumAccuracy')}" fill="none" stroke="${COLORS.muted}" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" vector-effect="non-scaling-stroke"/>
    <path d="${line('accuracy')}" fill="none" stroke="${COLORS.accent}" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

function renderHitRateChart() {
  // Use the metrics series for the selected family — it covers the full date
  // window (not just the current ledger page) and is already date-filtered.
  const f = activeFamilyMetrics();
  const chart = $('hr-chart');
  const axis = $('hr-axis');

  if (!f || f.series.length < 2) {
    chart.innerHTML = '<div class="chart-empty"></div>';
    axis.innerHTML = '<span>Not enough resolved calls to chart yet.</span>';
    $('hr-legend').innerHTML = '';
    return;
  }

  const pts = f.series;
  chart.innerHTML = hitRateChartFromSeries(pts);
  attachChartTip(chart, {
    xs: seriesXs(pts.length),
    at: i => {
      const p = pts[i]!;
      return {
        title: fmtDateTime(isoOf(p.t)),
        rows: [
          {
            label: `Recent (last ${f.window})`,
            value: fmtPct(p.accuracy),
            color: COLORS.accent,
          },
          {
            label: 'Cumulative',
            value: fmtPct(p.cumAccuracy),
            color: COLORS.muted,
          },
        ],
      };
    },
  });

  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  axis.innerHTML =
    `<span>${fmtDay(first.t)}</span>` +
    `<span class="hl">100% / 50% / 0%</span>` +
    `<span>${fmtDay(last.t)}</span>`;

  $('hr-legend').innerHTML = `
    <span class="key"><span class="swatch" style="background:${COLORS.accent}"></span>Recent form (last ${f.window})</span>
    <span class="key"><span class="swatch" style="background:${COLORS.muted}"></span>Cumulative</span>
    <span class="key"><span class="swatch dashed"></span>50% baseline</span>`;
}

function recordRow(e: LedgerEntry): string {
  const sideCls = e.side === 'UP' ? 'up' : 'down';
  let result: string;
  if (e.outcome == null) {
    result =
      '<span class="rec-result pending" title="Awaiting resolution">···</span>';
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

  // When the EV layer (paper trading) took this call, show the money: stake
  // at the tradable price, and the realized win/loss once resolved.
  const bet = paperById.get(e.id);
  let betBits = '';
  if (bet) {
    const money =
      bet.pnl === undefined
        ? `to win ${fmtUsd2((bet.stake * (1 - bet.cost)) / bet.cost)}`
        : `<span class="pt-pnl ${bet.pnl >= 0 ? 'up' : 'down'}">${bet.pnl >= 0 ? '+' : ''}${fmtUsd2(bet.pnl)}</span>`;
    betBits = `<span>· bet ${fmtUsd2(bet.stake)} at ${(bet.cost * 100).toFixed(1)}¢ → ${money}</span>`;
  }

  return `<div class="rec">
    ${result}
    <span class="rec-range">${e.rangeId}</span>
    <div class="rec-main">
      <span class="rec-when">${fmtDateTime(e.windowStart)}</span>
      <div class="rec-calls">
        called <span class="rec-side ${sideCls}">${e.side}</span>
        ${outcome}
        <span>· vs ${fmtUsd2(e.strike)}${closeBits}</span>
        ${betBits}
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
  renderRecordPagination();
}

/** Builds the /api/ledger query string with active date range + pagination. */
function ledgerQS(): string {
  const parts: string[] = [];
  if (selectedCrypto !== 'all') parts.push(`crypto=${selectedCrypto}`);
  const from = dateFrom();
  if (from) parts.push(`from=${encodeURIComponent(from)}`);
  parts.push(`page=${recordPage}`, `pageSize=${PAGE_SIZE}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

async function refreshRecord() {
  try {
    const res = await fetch(`/api/ledger${ledgerQS()}`);
    if (!res.ok) return;
    const data = (await res.json()) as {
      summary: LedgerSummary;
      filteredSummary: LedgerSummary;
      entries: LedgerEntry[];
      pagination: LedgerPagination;
    };
    ledgerEntries = data.entries;
    ledgerSummary = data.summary;
    ledgerFilteredSummary = data.filteredSummary;
    recordPagination = data.pagination;
    renderRecordSummary();
    renderDateRange();
    renderRecordFilters();
    renderRecordList();
    // Hit rate chart now uses metrics series — rendered by refreshMetrics().
    $('updated').textContent = new Date().toLocaleTimeString();
    $('app').classList.remove('loading');
  } catch {
    // Track record is best-effort; ignore transient failures.
  }
}

// ── Live trades (real-money execution record + fill verification) ─────────
let liveTrades: TradeRecord[] = [];

const POLYGONSCAN = 'https://polygonscan.com/tx/';

function verifyBadge(t: TradeRecord): string {
  if (t.status === 'dry-run') return '';
  if (!t.verifyStatus) return '<span class="lt-badge lt-badge-none" title="Not yet verified">?</span>';
  if (t.verifyStatus === 'match')
    return `<span class="lt-badge lt-badge-match" title="${t.verifyNote ?? ''}">✓</span>`;
  if (t.verifyStatus === 'mismatch')
    return `<span class="lt-badge lt-badge-mismatch" title="${t.verifyNote ?? ''}">⚠</span>`;
  if (t.verifyStatus === 'notfound')
    return `<span class="lt-badge lt-badge-notfound" title="${t.verifyNote ?? ''}">?</span>`;
  return `<span class="lt-badge lt-badge-error" title="${t.verifyNote ?? ''}">✗</span>`;
}

function txLinks(t: TradeRecord): string {
  const hashes = [
    ...(t.fillTxHashes ?? []),
    ...(t.redeemTx && t.redeemTx !== 'none' ? [t.redeemTx] : []),
  ];
  if (hashes.length === 0) return '';
  return hashes
    .map(
      (h, i) =>
        `<a class="lt-tx" href="${POLYGONSCAN}${h}" target="_blank" rel="noopener">` +
        `${i === 0 ? 'fill' : 'redeem'} ↗</a>`
    )
    .join(' ');
}

function liveTradeRow(t: TradeRecord): string {
  const statusCls =
    t.status === 'filled'
      ? 'lt-status-filled'
      : t.status === 'partial'
        ? 'lt-status-partial'
        : t.status === 'dry-run'
          ? 'lt-status-dryrun'
          : 'lt-status-other';

  const pnl =
    t.pnlUsd !== undefined
      ? `<span class="pt-pnl ${t.pnlUsd >= 0 ? 'up' : 'down'}">${t.pnlUsd >= 0 ? '+' : ''}${fmtUsd2(t.pnlUsd)}</span>`
      : t.shares !== undefined && t.costUsd !== undefined
        ? `<span class="pt-pnl">to win ${fmtUsd2((t.shares * (1 - t.quotedCost)) / t.quotedCost)}</span>`
        : '';

  const verifiedDetail =
    t.verifyStatus === 'match' || t.verifyStatus === 'mismatch'
      ? `<span class="lt-verified-detail">${t.verifyNote}</span>`
      : '';

  return `<div class="pt-bet lt-row">
    ${verifyBadge(t)}
    <span class="lt-status ${statusCls}">${t.status}</span>
    <span class="rec-range">${t.rangeId}</span>
    <span class="pt-when">${fmtDateTime(t.placedAt)}</span>
    <span class="rec-side ${t.side === 'UP' ? 'up' : 'down'}">${t.side}</span>
    <span class="pt-num">at ${(t.quotedCost * 100).toFixed(1)}¢</span>
    <span class="pt-num">bet ${fmtUsd2(t.costUsd ?? t.intendedUsd)}</span>
    ${pnl}
    ${txLinks(t)}
    ${verifiedDetail}
  </div>`;
}

function renderLiveTrades(trades: TradeRecord[]) {
  const card = $('live-trades-card');
  if (trades.length === 0) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';

  const settled = trades.filter(t => t.settledAt);
  const wins = settled.filter(t => t.won).length;
  const pnl = settled.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const pnlSign = pnl >= 0 ? '+' : '';
  const isDryRun = trades.every(t => t.status === 'dry-run');

  $('lt-sub').textContent =
    `${trades.length} trade${trades.length !== 1 ? 's' : ''}` +
    (isDryRun ? ' · shadow mode' : '') +
    ` · ${settled.length} settled (${wins}W–${settled.length - wins}L)`;

  $('lt-stats').innerHTML = `
    <div>
      <div class="rstat-label">P&amp;L</div>
      <div class="rstat-val" style="color:${pnl >= 0 ? COLORS.up : COLORS.down}">${pnlSign}${fmtUsd2(pnl)}</div>
    </div>
    <div>
      <div class="rstat-label">Staked</div>
      <div class="rstat-val">${fmtUsd2(settled.reduce((s, t) => s + (t.costUsd ?? 0), 0))}</div>
    </div>
    <div>
      <div class="rstat-label">Verified</div>
      <div class="rstat-val">${trades.filter(t => t.verifyStatus === 'match').length} / ${trades.filter(t => t.status !== 'dry-run' && (t.status === 'filled' || t.status === 'partial')).length}</div>
    </div>`;

  $('lt-trades').innerHTML = trades.map(liveTradeRow).join('');
}

async function refreshLiveTrades() {
  try {
    const res = await fetch('/api/trades');
    if (!res.ok) return;
    const data = (await res.json()) as TradesResponse;
    liveTrades = data.trades;
    renderLiveTrades(liveTrades);
  } catch {
    // Best-effort; keep last known state.
  }
}

function wireLiveTradesVerify() {
  const btn = $<HTMLButtonElement>('lt-verify-btn');
  const status = $('lt-verify-status');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Verifying…';
    status.textContent = '';
    try {
      const res = await fetch('/api/trades/verify', { method: 'POST' });
      if (!res.ok) throw new Error(`server ${res.status}`);
      const data = (await res.json()) as {
        counts: Record<string, number>;
        trades: TradeRecord[];
      };
      liveTrades = data.trades;
      renderLiveTrades(liveTrades);
      const c = data.counts;
      status.textContent =
        `✓ ${c.match} · ⚠ ${c.mismatch} · ? ${c.notfound}` +
        (c.error ? ` · ✗ ${c.error}` : '');
      status.className = 'lt-verify-status lt-verify-done';
    } catch (err) {
      status.textContent = `Error: ${err}`;
      status.className = 'lt-verify-status lt-verify-err';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Verify fills';
    }
  });
}

const refreshAll = () => {
  refreshHistory();
  refreshRecord();
  refreshMetrics();
  refreshPaper();
  refreshLiveTrades();
};
wireCryptoSelect(refreshAll);
wireLiveTradesVerify();
refreshHistory();
setInterval(refreshHistory, 5_000);
// The ledger only changes when windows resolve (server resolve loop ≈ 60s), so
// poll it on a slower cadence than the in-memory insights. Metrics derive from
// the same resolutions, so they share that cadence.
refreshRecord();
refreshMetrics();
refreshPaper();
refreshLiveTrades();
setInterval(refreshRecord, 30_000);
setInterval(refreshMetrics, 30_000);
setInterval(refreshPaper, 30_000);
setInterval(refreshLiveTrades, 30_000);
