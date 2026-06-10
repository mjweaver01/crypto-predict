import type {
  FamilyMetrics,
  InsightSnapshot,
  LedgerEntry,
  LedgerSummary,
  MetricsResponse,
  PaperBet,
  PaperResponse,
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
  loadPref,
  px,
  savePref,
} from './format.ts';
import { attachChartTip } from './chartTip.ts';

/** X positions (viewBox %) for n evenly spaced points, matching the charts'
 *  PADX=1.5 layout, so tooltip snapping lands exactly on the drawn points. */
const seriesXs = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => 1.5 + (i / Math.max(1, n - 1)) * 97);

const isoOf = (t: number) => new Date(t).toISOString();

// ── Previous reads (windowed insight history) ─────────────────────────────

// Entries whose full report is expanded, keyed by snapshot time so the state
// survives the periodic re-render.
const expandedReads = new Set<string>();

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
      const expanded = expandedReads.has(e.asOf);
      const reasoning = e.reasoning
        ? `<div class="hist-reasoning${expanded ? '' : ' clamped'}">${escapeHtml(e.reasoning)}</div>` +
          `<button class="read-more" data-read="${e.asOf}">${expanded ? 'Show less' : 'Read more'}</button>`
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
  for (const btn of list.querySelectorAll<HTMLButtonElement>('[data-read]')) {
    // Hide the toggle when the clamp isn't actually hiding anything.
    const body = btn.previousElementSibling as HTMLElement | null;
    if (
      body &&
      !expandedReads.has(btn.dataset.read!) &&
      body.scrollHeight <= body.clientHeight + 1
    ) {
      btn.style.display = 'none';
      continue;
    }
    btn.addEventListener('click', () => {
      const key = btn.dataset.read!;
      if (expandedReads.has(key)) expandedReads.delete(key);
      else expandedReads.add(key);
      renderHistory(entries);
    });
  }
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
let recordFilter: RecordFilter = loadPref(
  'filter',
  ['ALL', ...RECORD_RANGES] as const,
  'ALL'
);
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
      savePref('filter', recordFilter);
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
    const res = await fetch('/api/metrics');
    if (!res.ok) return;
    metrics = (await res.json()) as MetricsResponse;
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
  const polTxt =
    `min edge ${(pol.minEdge * 100).toFixed(0)}¢ · ` +
    `${(pol.kellyFraction * 100).toFixed(0)}% Kelly, ≤${(pol.maxStakeFraction * 100).toFixed(0)}%/bet`;

  const famFilter = recordFilter !== 'ALL';
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
            label: `${b.rangeId} ${b.side}, bet ${fmtUsd2(b.stake)}`,
            value: `${pnl >= 0 ? '+' : ''}${fmtUsd2(pnl)}`,
            color: pnl >= 0 ? COLORS.up : COLORS.down,
          });
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
    const res = await fetch('/api/paper');
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
/** Cumulative + rolling hit-rate series for a resolved-entry sequence. */
function computeHitPts(
  entries: LedgerEntry[]
): { cum: number; roll: number }[] {
  let correct = 0;
  return entries.map((e, i) => {
    if (e.correct) correct++;
    const cum = correct / (i + 1);
    const from = Math.max(0, i - ROLL_N + 1);
    let rollCorrect = 0;
    for (let j = from; j <= i; j++) if (entries[j]!.correct) rollCorrect++;
    const roll = rollCorrect / (i - from + 1);
    return { cum, roll };
  });
}

function hitRateChart(entries: LedgerEntry[]): string {
  if (entries.length < 2) return '<div class="chart-empty"></div>';

  const pts = computeHitPts(entries);

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
    pts.map((p, i) => `${i ? 'L' : 'M'}${px(X(i))} ${px(Y(p[key]))}`).join(' ');

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
  const pts = computeHitPts(entries);
  attachChartTip($('hr-chart'), {
    xs: seriesXs(entries.length),
    at: i => {
      const e = entries[i]!;
      const p = pts[i]!;
      return {
        title: fmtDateTime(e.windowStart),
        rows: [
          {
            label: `Recent (${Math.min(ROLL_N, i + 1)})`,
            value: fmtPct(p.roll),
            color: COLORS.accent,
          },
          { label: 'Cumulative', value: fmtPct(p.cum), color: COLORS.muted },
          {
            label: `${e.rangeId} ${e.side}`,
            value: e.correct ? '✓ hit' : '✗ miss',
            color: e.correct ? COLORS.up : COLORS.down,
          },
        ],
      };
    },
  });

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
// poll it on a slower cadence than the in-memory insights. Metrics derive from
// the same resolutions, so they share that cadence.
refreshRecord();
refreshMetrics();
refreshPaper();
setInterval(refreshRecord, 30_000);
setInterval(refreshMetrics, 30_000);
setInterval(refreshPaper, 30_000);
