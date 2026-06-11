import type {
  Prediction,
  PricePoint,
  PriceTick,
  RangeId,
  RangePrediction,
  SpotRangeId,
} from '../shared/types.ts';
import {
  $,
  COLORS,
  fmtClock,
  fmtDateTime,
  fmtDay,
  fmtPct,
  fmtUsd,
  fmtUsd2,
  loadPref,
  px,
  relTime,
  savePref,
} from './format.ts';
import { attachChartTip } from './chartTip.ts';

// ── Inline SVG charts (dependency-free) ──────────────────────────────────

/** Last `mins` minutes of history (1 sample ≈ 1 minute, plus the live point). */
function lastMinutes(history: PricePoint[], mins: number): PricePoint[] {
  return history.slice(-(mins + 1));
}

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

interface HeroRender {
  /** The chart SVG markup (or an empty-state placeholder). */
  svg: string;
  /** Live-dot position (viewBox %) + colour, or null when there's no line. */
  dot: { x: number; y: number; color: string } | null;
}

/**
 * Large Polymarket-style price chart: gradient area + line coloured by the
 * window's net direction. Drawn in a 0..100 viewBox that stretches to fill its
 * container (non-scaling stroke keeps the line crisp). The live dot is returned
 * separately so it can live in a persistent DOM node (its pulse animation must
 * not restart when the SVG is redrawn each animation frame).
 */
function heroRender(points: PricePoint[]): HeroRender {
  if (points.length < 2) {
    return { svg: '<div class="chart-empty"></div>', dot: null };
  }
  const prices = points.map(p => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1;
  const t0 = points[0]!.t;
  const span = points[points.length - 1]!.t - t0 || 1;
  const PAD = 8; // vertical breathing room (viewBox units)
  const X = (t: number) => ((t - t0) / span) * 100;
  const Y = (p: number) => PAD + (1 - (p - min) / range) * (100 - 2 * PAD);

  const up = prices[prices.length - 1]! >= prices[0]!;
  const color = up ? COLORS.up : COLORS.down;
  const gid = up ? 'heroUp' : 'heroDown';

  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${px(X(p.t))} ${px(Y(p.price))}`)
    .join(' ');
  const area = `${d} L 100 100 L 0 100 Z`;
  const last = points[points.length - 1]!;

  const svg = `<svg viewBox="0 0 100 100" preserveAspectRatio="none">
    <defs>
      <linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.28"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <path d="${area}" fill="url(#${gid})"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
  </svg>`;

  return { svg, dot: { x: X(last.t), y: Y(last.price), color } };
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
  '4h': 120,
  '1d': 120,
};

const RANGE_IDS: readonly RangeId[] = ['5m', '15m', '1h', '4h', '1d'];
let selected: RangeId | null = loadPref('tab', RANGE_IDS, '5m');
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
      // Per-tab call chip: the frozen committed side when one exists (solid),
      // otherwise the live lean (hollow) so every family shows its yes/no.
      const side = r.committed?.side ?? (r.probUp >= 0.5 ? 'UP' : 'DOWN');
      const chipCls = `tab-side ${side === 'UP' ? 'up' : 'down'}${r.committed ? '' : ' tentative'}`;
      return `<button class="tab${active}" role="tab" data-id="${r.id}">
        <span class="tab-top">
          <span class="tab-label">${r.label}</span>
          <span class="${chipCls}">${side}</span>
        </span>
        <span class="tab-timer" data-end="${r.windowEnd}">—</span>
        <span class="tab-sub">${sub}</span>
      </button>`;
    })
    .join('');
  for (const btn of tabs.querySelectorAll<HTMLButtonElement>('.tab')) {
    btn.addEventListener('click', () => {
      selected = btn.dataset.id as RangeId;
      savePref('tab', selected);
      if (latest) {
        renderTabs(latest);
        renderDetail(latest);
      }
    });
  }
  tickCountdowns();
}

// ── Window countdowns (tabs + detail panel), ticking every second ─────────

/** Compact remaining-time label: 4:32 under an hour, 3h 12m under a day. */
function fmtCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  if (s < 3600)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86_400);
  return `${d}d ${Math.floor((s % 86_400) / 3600)}h`;
}

/**
 * Repaint every element carrying a `data-end` window close time. Elements are
 * re-created by renderTabs/renderDetail each refresh, so this just queries the
 * DOM — no bookkeeping. Goes "closing" (red, pulsing) inside the last minute.
 *
 * When any countdown hits zero the window has rolled over, so fetch right away
 * instead of waiting out the 5s poll. This re-fires on each 1s tick while
 * expired windows are still on screen (refresh() is inflight-guarded), and
 * stops naturally once the new window's data replaces the old `data-end`s.
 */
function tickCountdowns() {
  const now = Date.now();
  let expired = false;
  for (const el of document.querySelectorAll<HTMLElement>('[data-end]')) {
    const end = Date.parse(el.dataset.end ?? '');
    if (!Number.isFinite(end)) continue;
    const left = end - now;
    el.textContent = fmtCountdown(left);
    el.classList.toggle('closing', left <= 60_000 && left > 0);
    if (left <= 0) expired = true;
  }
  if (expired) void refresh();
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
  $('d-market-window').textContent =
    `${fmtClock(m.windowStart)} – ${fmtClock(m.windowEnd)}`;

  // The wager is the COMMITTED call (frozen early), so the edge that informs a
  // bet is the committed probability vs the live market price — NOT the live
  // read, which collapses toward 0/1 near expiry and would inflate the "edge"
  // exactly when the bet is no longer placeable. Fall back to the live read only
  // when no call was committed for this window.
  const wagerUp = r.committed ? r.committed.probUp : r.probUp;
  $('d-market-bars').innerHTML = compareBars(m.impliedUp, wagerUp);

  // The midpoint is not a price anyone fills at — surface the actual order
  // book and price the wager's side off it: Up costs the ask, Down costs
  // 1 - bid. Only when the book is unavailable fall back to midpoint edge.
  const cents = (v: number) => `${(v * 100).toFixed(1)}¢`;
  const bookEl = $('d-book');
  if (m.upBestBid !== undefined || m.upBestAsk !== undefined) {
    bookEl.style.display = 'block';
    bookEl.textContent =
      `Book (Up token): ${m.upBestBid !== undefined ? cents(m.upBestBid) : '—'} bid / ` +
      `${m.upBestAsk !== undefined ? cents(m.upBestAsk) : '—'} ask`;
  } else {
    bookEl.style.display = 'none';
  }

  const edgeEl = $('d-edge');
  const basis = r.committed ? 'committed' : 'live read';
  const side = wagerUp >= 0.5 ? 'UP' : 'DOWN';
  const cost =
    side === 'UP'
      ? m.upBestAsk
      : m.upBestBid !== undefined
        ? 1 - m.upBestBid
        : undefined;
  if (cost !== undefined && cost > 0 && cost < 1) {
    const pSide = side === 'UP' ? wagerUp : 1 - wagerUp;
    const edge = pSide - cost;
    edgeEl.textContent =
      `Tradable edge: ${edge >= 0 ? '+' : ''}${cents(edge)} on ${side} ` +
      `(costs ${cents(cost)}, model ${fmtPct(pSide)}) · ${basis}`;
    edgeEl.className = `edge ${edge >= 0 ? 'up' : 'down'}`;
  } else {
    const edge = wagerUp - m.impliedUp;
    edgeEl.textContent = `Edge vs market: ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts ${
      edge >= 0 ? '(model favors Up)' : '(model favors Down)'
    } · ${basis}`;
    edgeEl.className = `edge ${edge >= 0 ? 'up' : 'down'}`;
  }

  // The EV layer's frozen verdict on the committed call: bet (with Kelly
  // sizing) or abstain. This is the same decision the paper-trading replay
  // grades, so the live chip and the scoreboard always agree.
  const paperEl = $('d-paper');
  const pd = r.paper;
  if (!pd) {
    paperEl.style.display = 'none';
  } else {
    paperEl.style.display = 'block';
    if (pd.action === 'BET') {
      paperEl.innerHTML =
        `<span class="paper-chip bet">PAPER BET</span>` +
        `${pd.side} at ${cents(pd.cost!)} · edge +${cents(pd.edge!)} · ` +
        `stake ${(pd.stakeFraction * 100).toFixed(1)}% of bankroll`;
    } else {
      const why =
        pd.reason === 'no-book'
          ? 'no order book at commit'
          : `edge ${pd.edge !== undefined && pd.edge >= 0 ? '+' : ''}${
              pd.edge !== undefined ? cents(pd.edge) : '—'
            } below minimum`;
      paperEl.innerHTML = `<span class="paper-chip pass">NO BET</span>${why}`;
    }
  }

  $('d-note').textContent = r.strikeIsProxy
    ? 'Resolves on Chainlink BTC/USD; strike shown is a Binance-open proxy (Polymarket price-to-beat unavailable).'
    : r.resolutionSource === 'chainlink'
      ? "Resolves on Chainlink BTC/USD; strike is Polymarket's exact price to beat."
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
    r.resolutionSource === 'chainlink'
      ? 'Chainlink BTC/USD'
      : 'Binance BTC/USDT';
  $('d-window').textContent =
    `${fmtClock(r.windowStart)} → ${fmtClock(r.windowEnd)} · closes ${relTime(r.windowEnd)}`;
  $('d-countdown').dataset.end = r.windowEnd;

  // The headline verdict is the COMMITTED call (locked in early, never flips).
  // Fall back to the live read only when no genuine call was committed.
  const c = r.committed;
  const verdictUp = c ? c.side === 'UP' : up >= 0.5;
  const verdict = $('d-verdict');
  verdict.textContent = verdictUp ? 'UP' : 'DOWN';
  verdict.className = `verdict ${verdictUp ? 'up' : 'down'}`;

  const committedEl = $('d-committed');
  if (c) {
    committedEl.textContent =
      `Committed ${c.side} ${fmtPct(c.confidence)} · locked at ${fmtClock(c.decidedAt)} ` +
      `(${c.horizonMinutes.toFixed(1)}m left)`;
    committedEl.className = `detail-window committed ${c.side === 'UP' ? 'up' : 'down'}`;
  } else {
    committedEl.textContent =
      'No committed call — window opened before tracking began';
    committedEl.className = 'detail-window committed muted';
  }

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
  if (pts.length >= 2) {
    const t0 = pts[0]!.t;
    const span = pts[pts.length - 1]!.t - t0 || 1;
    attachChartTip($('d-chart'), {
      xs: pts.map(pt => ((pt.t - t0) / span) * 100),
      at: i => {
        const pt = pts[i]!;
        const diff = pt.price - r.strike;
        return {
          title: new Date(pt.t).toLocaleTimeString(),
          rows: [
            { label: 'Price', value: fmtUsd2(pt.price), color },
            {
              label: 'vs strike',
              value: `${diff >= 0 ? '+' : ''}${fmtUsd2(diff)}`,
              color: diff >= 0 ? COLORS.up : COLORS.down,
            },
          ],
        };
      },
    });
  }

  $('d-above').textContent = fmtPct(r.probUp);
  const calib = $('d-calib');
  if (r.calibration?.active) {
    const delta = Math.round((r.probUp - r.rawProbUp) * 100);
    const adj =
      delta === 0
        ? 'no adjustment'
        : `${delta > 0 ? '+' : ''}${delta} pts vs raw ${fmtPct(r.rawProbUp)}`;
    calib.textContent = `Calibrated on ${r.calibration.samples} resolved calls · ${adj}`;
  } else {
    const have = r.calibration?.samples ?? 0;
    calib.textContent = `Uncalibrated · learning (${have} resolved calls so far)`;
  }
  $('d-point').textContent = fmtUsd(r.forecast.point);
  $('d-band').textContent =
    `${fmtUsd(r.forecast.low)} – ${fmtUsd(r.forecast.high)}`;

  renderMarketBlock(r);
}

// ── Spot price range toggle (LIVE, 1H … 1W) ──────────────────────────────
const SPOT_RANGES: SpotRangeId[] = ['LIVE', '1H', '6H', '1D', '1W'];
let selectedSpot: SpotRangeId = loadPref('spot', SPOT_RANGES, '1D');

// Rolling buffer of streamed ticks for the client-only LIVE (1-minute) view.
const LIVE_WINDOW_MS = 60_000;
const liveTicks: PricePoint[] = [];

function renderSpotRanges() {
  const el = $('spot-ranges');
  el.innerHTML = SPOT_RANGES.map(
    id =>
      `<button data-spot="${id}" class="${id === selectedSpot ? 'active' : ''}">${id}</button>`
  ).join('');
  for (const btn of el.querySelectorAll<HTMLButtonElement>('button')) {
    btn.addEventListener('click', () => {
      selectedSpot = btn.dataset.spot as SpotRangeId;
      savePref('spot', selectedSpot);
      renderSpotRanges();
      renderHero();
    });
  }
}

/**
 * The series for the active range. The trailing edge uses `displayPrice` (an
 * eased value, see the animation loop) at a continuously-advancing `now`, so the
 * line scrolls and rises/falls smoothly rather than snapping once per tick.
 * LIVE is the last ~1m of streamed ticks; server ranges get the edge grafted on.
 */
function heroSeries(): PricePoint[] {
  const edge = displayPrice ?? lastTickPrice;
  const now = Date.now();
  if (selectedSpot === 'LIVE') {
    if (liveTicks.length === 0) return [];
    return edge !== null ? [...liveTicks, { t: now, price: edge }] : liveTicks;
  }
  const base = latest?.spot?.[selectedSpot] ?? latest?.history ?? [];
  if (edge !== null && base.length) return [...base, { t: now, price: edge }];
  return base;
}

function renderHeroChart() {
  const pts = heroSeries();
  const { svg, dot } = heroRender(pts);
  $('hero-svg').innerHTML = svg;
  // Hover readout lives on the chart container (sibling of the SVG host, so
  // the per-frame innerHTML swap doesn't wipe it).
  const host = $('hero-svg').parentElement;
  if (host && pts.length >= 2) {
    const t0 = pts[0]!.t;
    const span = pts[pts.length - 1]!.t - t0 || 1;
    const longSpan = span > 24 * 3_600_000;
    attachChartTip(host, {
      xs: pts.map(p => ((p.t - t0) / span) * 100),
      at: i => {
        const p = pts[i]!;
        return {
          title: longSpan
            ? fmtDateTime(new Date(p.t).toISOString())
            : new Date(p.t).toLocaleTimeString(),
          rows: [
            {
              label: 'BTC/USDT',
              value: fmtUsd2(p.price),
              color: COLORS.accent,
            },
          ],
        };
      },
    });
  }
  const dotEl = $('live-dot');
  if (dot) {
    dotEl.style.display = '';
    dotEl.style.left = `${px(dot.x)}%`;
    dotEl.style.top = `${px(dot.y)}%`;
    dotEl.style.background = dot.color;
    dotEl.style.color = dot.color;
  } else {
    dotEl.style.display = 'none';
  }
}

function renderHeroAxis() {
  const pts = heroSeries();
  if (pts.length >= 2) {
    const prices = pts.map(h => h.price);
    const hi = Math.max(...prices);
    const lo = Math.min(...prices);
    const span = pts[pts.length - 1]!.t - pts[0]!.t;
    const startLabel =
      span > 24 * 3_600_000
        ? fmtDay(pts[0]!.t)
        : fmtClock(new Date(pts[0]!.t).toISOString());
    $('hero-axis').innerHTML =
      `<span>${startLabel}</span>` +
      `<span class="hl">H <b>${fmtUsd(hi)}</b> · L <b>${fmtUsd(lo)}</b></span>` +
      `<span>now</span>`;
  } else {
    $('hero-axis').innerHTML = '';
  }
}

function renderHero() {
  renderHeroChart();
  renderHeroAxis();
}

// Eased price shown at the chart's right edge; chases the latest tick each frame
// so vertical moves are gradual. Time advances continuously for a smooth scroll.
let displayPrice: number | null = null;
const EASE = 0.08; // per-frame approach toward the latest tick (~1s settle)

function animateHero() {
  requestAnimationFrame(animateHero);
  if (lastTickPrice === null) return;
  displayPrice =
    displayPrice === null
      ? lastTickPrice
      : displayPrice + (lastTickPrice - displayPrice) * EASE;
  renderHeroChart();
}

function render(p: Prediction) {
  latest = p;

  // Header. Once the live stream is feeding the price/change, leave those to it
  // so the (up-to-20s-cached) predict payload doesn't snap them backwards.
  if (!streaming) {
    $('price').textContent = fmtUsd(p.stats.price);
    applyChange(p.stats.change24hPct);
  }
  $('vol').textContent = `σ ${(p.stats.volPerHour * 100).toFixed(2)}%/h`;

  // Hero price chart: range toggle + selected series
  renderSpotRanges();
  renderHero();

  // Narrative + method
  $('narrative').textContent = p.narrative;
  renderReasoning(p.reasoning);
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

// ── Full LLM report, clamped behind a "read more" toggle ─────────────────
// Collapsed by default; expansion survives the 5s refresh (the read itself
// only changes every 5m window or on manual refresh) and resets on new text.
let reasoningExpanded = false;
let lastReasoning = '';

function renderReasoning(text: string | undefined) {
  const el = $('reasoning');
  const toggle = $<HTMLButtonElement>('reasoning-toggle');
  if (!text) {
    el.classList.remove('visible');
    el.textContent = '';
    toggle.style.display = 'none';
    lastReasoning = '';
    return;
  }
  if (text !== lastReasoning) {
    lastReasoning = text;
    reasoningExpanded = false; // fresh read → collapse again
  }
  el.textContent = text;
  el.classList.add('visible');
  el.classList.toggle('clamped', !reasoningExpanded);
  // Show the toggle only when the clamp actually hides content (or when
  // expanded, so it can be collapsed back). The clamp height comes from the
  // parent card, so this is re-checked on resize too.
  const overflows = el.scrollHeight > el.clientHeight + 1;
  el.classList.toggle('truncated', !reasoningExpanded && overflows);
  toggle.style.display = reasoningExpanded || overflows ? '' : 'none';
  toggle.textContent = reasoningExpanded ? 'Show less' : 'Read more';
}

function wireReasoningToggle() {
  $<HTMLButtonElement>('reasoning-toggle').addEventListener('click', () => {
    reasoningExpanded = !reasoningExpanded;
    renderReasoning(lastReasoning);
  });
  // The available height depends on the layout, so re-evaluate the clamp
  // whenever the viewport changes.
  window.addEventListener('resize', () => {
    if (lastReasoning) renderReasoning(lastReasoning);
  });
}

// On-demand LLM read: the server refreshes its read once per 5m window (at the
// commit boundary); this button forces a brand-new read right now.
function wireReadRefresh() {
  const btn = $<HTMLButtonElement>('read-refresh');
  const card = btn.closest('.narrative-card');
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add('loading');
    card?.classList.add('refreshing');
    try {
      const res = await fetch('/api/read/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`refresh ${res.status}`);
      render((await res.json()) as Prediction);
      $('error').textContent = '';
    } catch (err) {
      $('error').textContent = `Failed to refresh read: ${String(err)}`;
    } finally {
      btn.disabled = false;
      btn.classList.remove('loading');
      card?.classList.remove('refreshing');
    }
  });
}

// ── Live spot price stream (SSE) ─────────────────────────────────────────
// True once the first tick arrives, after which the stream owns #price/#change.
let streaming = false;
let lastTickPrice: number | null = null;

function applyChange(pct: number) {
  const chg = $('change');
  chg.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% 24h`;
  chg.className = `change ${pct >= 0 ? 'up' : 'down'}`;
}

function applyTick(tick: PriceTick) {
  streaming = true;
  $('price').textContent = fmtUsd(tick.price);
  applyChange(tick.change24hPct);
  lastTickPrice = tick.price;

  // Feed the rolling 1-minute LIVE buffer. The chart itself is redrawn by the
  // animation loop (eased); here we just refresh the axis H/L once per tick.
  liveTicks.push({ t: tick.t, price: tick.price });
  const cutoff = tick.t - LIVE_WINDOW_MS;
  while (liveTicks.length > 2 && liveTicks[0]!.t < cutoff) liveTicks.shift();
  renderHeroAxis();
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

refresh();
setInterval(refresh, 5_000);
setInterval(tickCountdowns, 1_000);
wireReadRefresh();
wireReasoningToggle();
connectPriceStream();
requestAnimationFrame(animateHero);
