import type {
  Prediction,
  PricePoint,
  RangeId,
  RangePrediction,
} from '../shared/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmtUsd2 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;

const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

function relTime(targetIso: string): string {
  const mins = Math.round((new Date(targetIso).getTime() - Date.now()) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 24) return `in ${(mins / 60).toFixed(1)}h`;
  return `in ${(mins / (60 * 24)).toFixed(1)}d`;
}

// ── Inline SVG charts (dependency-free) ──────────────────────────────────
const COLORS = {
  up: '#34d399',
  down: '#f87171',
  accent: '#f7931a',
  muted: '#7b8fa8',
};

/** Last `mins` minutes of history (1 sample ≈ 1 minute, plus the live point). */
function lastMinutes(history: PricePoint[], mins: number): PricePoint[] {
  return history.slice(-(mins + 1));
}

const px = (n: number) => n.toFixed(2);

/** A price sparkline scaled to a 100x32 viewBox, with an optional strike line. */
function sparkline(
  points: PricePoint[],
  color: string,
  opts: { strike?: number } = {}
): string {
  if (points.length < 2) return '<div class="chart-empty"></div>';
  const W = 100;
  const H = 32;
  const prices = points.map(p => p.price);
  let min = Math.min(...prices);
  let max = Math.max(...prices);
  if (opts.strike !== undefined) {
    min = Math.min(min, opts.strike);
    max = Math.max(max, opts.strike);
  }
  const pad = (max - min) * 0.12 || 1;
  min -= pad;
  max += pad;
  const t0 = points[0]!.t;
  const span = points[points.length - 1]!.t - t0 || 1;
  const X = (t: number) => ((t - t0) / span) * W;
  const Y = (p: number) => H - ((p - min) / (max - min)) * H;

  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${px(X(p.t))} ${px(Y(p.price))}`)
    .join(' ');
  const area = `${d} L ${px(W)} ${px(H)} L 0 ${px(H)} Z`;
  const strikeLine =
    opts.strike !== undefined
      ? `<line x1="0" y1="${px(Y(opts.strike))}" x2="${W}" y2="${px(Y(opts.strike))}" stroke="${COLORS.accent}" stroke-width="1" stroke-dasharray="3 2" opacity="0.8" vector-effect="non-scaling-stroke"/>`
      : '';

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <path d="${area}" fill="${color}" fill-opacity="0.12"/>
    ${strikeLine}
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

/** Two comparison bars: market-implied vs our model probability of Up. */
function compareBars(marketUp: number, modelUp: number): string {
  const row = (label: string, v: number, color: string) => `
    <div style="display:flex;align-items:center;gap:8px;font-size:11px;">
      <span style="width:56px;color:var(--text-dim);">${label}</span>
      <div style="flex:1;height:8px;border-radius:5px;background:rgba(255,255,255,0.05);overflow:hidden;">
        <div style="height:100%;width:${(v * 100).toFixed(1)}%;background:${color};transition:width .4s ease;"></div>
      </div>
      <span style="width:44px;text-align:right;font-variant-numeric:tabular-nums;">${fmtPct(v)}</span>
    </div>`;
  return `<div style="display:flex;flex-direction:column;gap:8px;">
    ${row('Market', marketUp, COLORS.accent)}
    ${row('Model', modelUp, modelUp >= 0.5 ? COLORS.up : COLORS.down)}
  </div>`;
}

// ── Tabbed detail view ───────────────────────────────────────────────────
// How much 1m history to show per range (longer windows get more context).
const CHART_MINUTES: Record<RangeId, number> = {
  '5m': 30,
  '15m': 90,
  '1h': 120,
  '1d': 120,
};

let selected: RangeId | null = null;
let latest: Prediction | null = null;

function renderTabs(p: Prediction) {
  if (!selected || !p.ranges.some(r => r.id === selected)) {
    selected = p.ranges[0]?.id ?? null;
  }
  const tabs = $('tabs');
  tabs.innerHTML = p.ranges
    .map(r => {
      const active = r.id === selected ? ' active' : '';
      const sub = r.market ? `mkt ${fmtPct(r.market.impliedUp)}` : 'model only';
      return `<button class="tab${active}" role="tab" data-id="${r.id}">${r.label}<span class="tab-sub">${sub}</span></button>`;
    })
    .join('');
  for (const btn of tabs.querySelectorAll<HTMLButtonElement>('.tab')) {
    btn.addEventListener('click', () => {
      selected = btn.dataset.id as RangeId;
      if (latest) {
        renderTabs(latest);
        renderDetail(latest);
      }
    });
  }
}

function renderMarketBlock(r: RangePrediction) {
  const block = $('d-market');
  const none = $('d-nomarket');
  const m = r.market;
  if (!m) {
    block.style.display = 'none';
    none.style.display = 'block';
    return;
  }
  block.style.display = 'block';
  none.style.display = 'none';
  $('d-market-q').textContent = m.question;
  $('d-market-window').textContent = `${fmtClock(m.windowStart)} – ${fmtClock(m.windowEnd)}`;
  $('d-market-bars').innerHTML = compareBars(m.impliedUp, r.probUp);

  const edge = r.probUp - m.impliedUp;
  const edgeEl = $('d-edge');
  edgeEl.textContent = `Edge vs market: ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts ${
    edge >= 0 ? '(model favors Up)' : '(model favors Down)'
  }`;
  edgeEl.className = `edge ${edge >= 0 ? 'up' : 'down'}`;

  $('d-note').textContent = r.strikeIsProxy
    ? 'Resolves on Chainlink BTC/USD; strike shown is a Binance-open proxy for the price to beat.'
    : r.id === '1d'
      ? 'Resolves on the Binance BTC/USDT 1m close at noon ET vs the prior noon.'
      : 'Resolves on the Binance BTC/USDT 1h candle (close vs open).';
}

function renderDetail(p: Prediction) {
  const r = p.ranges.find(x => x.id === selected) ?? p.ranges[0];
  if (!r) return;
  const up = r.probUp;

  $('d-title').textContent = `Up / Down · ${r.label}`;
  $('d-source').textContent =
    r.resolutionSource === 'chainlink' ? 'Chainlink BTC/USD' : 'Binance BTC/USDT';
  $('d-window').textContent = `${fmtClock(r.windowStart)} → ${fmtClock(r.windowEnd)} · closes ${relTime(r.windowEnd)}`;

  const verdict = $('d-verdict');
  verdict.textContent = up >= 0.5 ? 'UP' : 'DOWN';
  verdict.className = `verdict ${up >= 0.5 ? 'up' : 'down'}`;

  const upPct = Math.round(up * 100);
  $('d-up').style.width = `${upPct}%`;
  $('d-down').style.width = `${100 - upPct}%`;
  $('d-up-pct').textContent = `Up ${fmtPct(up)}`;
  $('d-down-pct').textContent = `Down ${fmtPct(1 - up)}`;

  const beatWord = r.strikeIsProxy ? '≈ price to beat' : 'price to beat';
  $('d-beat').textContent = `vs ${fmtUsd2(r.strike)} (${beatWord})`;

  const pts = lastMinutes(p.history, CHART_MINUTES[r.id]);
  const last = pts[pts.length - 1];
  const color = last && last.price >= r.strike ? COLORS.up : COLORS.down;
  $('d-chart').innerHTML = sparkline(pts, color, { strike: r.strike });

  $('d-above').textContent = fmtPct(r.probUp);
  $('d-point').textContent = fmtUsd(r.forecast.point);
  $('d-band').textContent = `${fmtUsd(r.forecast.low)} – ${fmtUsd(r.forecast.high)}`;

  renderMarketBlock(r);
}

function render(p: Prediction) {
  latest = p;

  // Header
  $('price').textContent = fmtUsd(p.stats.price);
  const chg = $('change');
  chg.textContent = `${p.stats.change24hPct >= 0 ? '+' : ''}${p.stats.change24hPct.toFixed(2)}% 24h`;
  chg.className = `change ${p.stats.change24hPct >= 0 ? 'up' : 'down'}`;
  $('vol').textContent = `σ ${(p.stats.volPerHour * 100).toFixed(2)}%/h`;

  // Narrative + method
  $('narrative').textContent = p.narrative;
  const reasoning = $('reasoning');
  if (p.reasoning) {
    reasoning.textContent = p.reasoning;
    reasoning.classList.add('visible');
  } else {
    reasoning.classList.remove('visible');
  }
  $('method').textContent = p.llmApplied ? 'LLM-assisted' : 'Stats-only';

  // Tabs + selected range detail
  renderTabs(p);
  renderDetail(p);

  $('updated').textContent = new Date(p.asOf).toLocaleTimeString();
  $('app').classList.remove('loading');
}

let inflight = false;
async function refresh() {
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch('/api/predict');
    if (!res.ok) throw new Error(`predict ${res.status}`);
    render((await res.json()) as Prediction);
    $('error').textContent = '';
  } catch (err) {
    $('error').textContent = `Failed to load: ${String(err)}`;
  } finally {
    inflight = false;
  }
}

refresh();
setInterval(refresh, 5_000);
