import type { Prediction } from '../shared/types.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

const fmtUsd2 = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;

const strikeInput = $<HTMLInputElement>('strike');
const targetInput = $<HTMLInputElement>('target');

// Default target = the end of the current 5-minute interval we're in.
const INTERVAL_MS = 5 * 60_000;
function defaultTarget(): string {
  const now = Date.now();
  const end = Math.floor(now / INTERVAL_MS) * INTERVAL_MS + INTERVAL_MS;
  // datetime-local wants local time without timezone, trimmed to minutes.
  const off = new Date(end).getTimezoneOffset() * 60_000;
  return new Date(end - off).toISOString().slice(0, 16);
}

function buildQuery(): string {
  const params = new URLSearchParams();
  const strike = strikeInput.value.trim();
  const target = targetInput.value.trim();
  if (strike) params.set('strike', strike);
  if (target) params.set('target', new Date(target).toISOString());
  const q = params.toString();
  return q ? `?${q}` : '';
}

/** Render a horizontal up/down probability bar. */
function renderDirection(prefix: string, probUp: number) {
  const upPct = Math.round(probUp * 100);
  $(`${prefix}-up`).style.width = `${upPct}%`;
  $(`${prefix}-down`).style.width = `${100 - upPct}%`;
  $(`${prefix}-up-pct`).textContent = `Up ${fmtPct(probUp)}`;
  $(`${prefix}-down-pct`).textContent = `Down ${fmtPct(1 - probUp)}`;
  const verdict = $(`${prefix}-verdict`);
  verdict.textContent = probUp >= 0.5 ? 'UP' : 'DOWN';
  verdict.className = `verdict ${probUp >= 0.5 ? 'up' : 'down'}`;
}

function relTime(targetIso: string): string {
  const mins = Math.round((new Date(targetIso).getTime() - Date.now()) / 60_000);
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${(mins / 60).toFixed(1)}h`;
  return `${(mins / (60 * 24)).toFixed(1)}d`;
}

function render(p: Prediction) {
  // Header
  $('price').textContent = fmtUsd(p.stats.price);
  const chg = $('change');
  chg.textContent = `${p.stats.change24hPct >= 0 ? '+' : ''}${p.stats.change24hPct.toFixed(2)}% 24h`;
  chg.className = `change ${p.stats.change24hPct >= 0 ? 'up' : 'down'}`;
  $('vol').textContent = `σ ${(p.stats.volPerHour * 100).toFixed(2)}%/h`;

  // Up/Down cards
  renderDirection('m5', p.up5m.probUp);
  renderDirection('m15', p.up15m.probUp);

  // Above strike
  $('above-pct').textContent = fmtPct(p.above.probAbove);
  $('above-detail').textContent =
    `P(close > ${fmtUsd2(p.above.strike)} in ${relTime(p.above.targetTime)})`;
  $('above-bar').style.width = `${Math.round(p.above.probAbove * 100)}%`;

  // Price forecast
  $('forecast-point').textContent = fmtUsd(p.price.point);
  $('forecast-band').textContent = `${fmtUsd(p.price.low)} – ${fmtUsd(p.price.high)}`;
  $('forecast-detail').textContent = `point forecast in ${relTime(p.price.targetTime)} (95% band)`;

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

  $('updated').textContent = new Date(p.asOf).toLocaleTimeString();
  $('app').classList.remove('loading');
}

// While the user hasn't picked their own target, keep it pinned to the
// current 5-minute interval so the default tracks real time.
let userSetTarget = false;

let inflight = false;
async function refresh() {
  if (!userSetTarget) targetInput.value = defaultTarget();
  if (inflight) return;
  inflight = true;
  try {
    const res = await fetch(`/api/predict${buildQuery()}`);
    if (!res.ok) throw new Error(`predict ${res.status}`);
    render((await res.json()) as Prediction);
    $('error').textContent = '';
  } catch (err) {
    $('error').textContent = `Failed to load: ${String(err)}`;
  } finally {
    inflight = false;
  }
}

targetInput.value = defaultTarget();
strikeInput.addEventListener('change', refresh);
targetInput.addEventListener('change', () => {
  userSetTarget = targetInput.value.trim() !== '';
  refresh();
});

refresh();
setInterval(refresh, 5_000);
