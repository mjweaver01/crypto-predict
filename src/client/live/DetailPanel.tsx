// The selected range's detail card: committed verdict, live read split, the
// price-vs-strike chart, P(close ≥ strike) + forecast, and the live Polymarket
// market block (edge + paper verdict). Mirrors the old renderDetail exactly.

import type { RangePrediction } from '../../shared/types.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import {
  COLORS,
  fmtClock,
  fmtPct,
  fmtUsd,
  fmtUsd2,
  relTime,
} from '../format.ts';
import {
  CHART_MINUTES,
  lastMinutes,
  sparkline,
  compareBars,
} from '../charts.ts';
import { Chart } from '../components/Chart.tsx';
import { latest, selectedTab } from './state.ts';
import { Countdown } from './Countdown.tsx';

const cents = (v: number) => `${(v * 100).toFixed(1)}¢`;

function MarketBlock({ r }: { r: RangePrediction }) {
  const m = r.market;
  if (!m) {
    return (
      <div class="market-block muted">
        No live Polymarket market for this window right now.
      </div>
    );
  }

  const c = r.committed;
  const wagerUp = c ? c.probUp : r.probUp;
  const basis = c ? 'committed' : 'live read';
  const side = wagerUp >= 0.5 ? 'UP' : 'DOWN';
  const cost =
    side === 'UP'
      ? m.upBestAsk
      : m.upBestBid !== undefined
        ? 1 - m.upBestBid
        : undefined;

  let edgeText: string;
  let edgeUp: boolean;
  if (cost !== undefined && cost > 0 && cost < 1) {
    const pSide = side === 'UP' ? wagerUp : 1 - wagerUp;
    const edge = pSide - cost;
    edgeUp = edge >= 0;
    edgeText =
      `Tradable edge: ${edge >= 0 ? '+' : ''}${cents(edge)} on ${side} ` +
      `(costs ${cents(cost)}, model ${fmtPct(pSide)}) · ${basis}`;
  } else {
    const edge = wagerUp - m.impliedUp;
    edgeUp = edge >= 0;
    edgeText =
      `Edge vs market: ${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)} pts ` +
      `${edge >= 0 ? '(model favors Up)' : '(model favors Down)'} · ${basis}`;
  }

  const hasBook = m.upBestBid !== undefined || m.upBestAsk !== undefined;
  const noteTkr = CRYPTOS[r.crypto]?.ticker ?? 'BTC';
  const note = r.strikeIsProxy
    ? `Resolves on Chainlink ${noteTkr}/USD; strike shown is a Binance-open proxy (Polymarket price-to-beat unavailable).`
    : r.resolutionSource === 'chainlink'
      ? `Resolves on Chainlink ${noteTkr}/USD; strike is Polymarket's exact price to beat.`
      : r.id === '1d'
        ? `Resolves on the Binance ${noteTkr}/USDT 1m close at noon ET vs the prior noon.`
        : `Resolves on the Binance ${noteTkr}/USDT 1h candle (close vs open).`;

  return (
    <div class="market-block">
      <div class="card-title" style={{ marginBottom: '10px' }}>
        <span>{m.question}</span>
        <span class="window-tag">
          {fmtClock(m.windowStart)} – {fmtClock(m.windowEnd)}
        </span>
      </div>
      <div
        dangerouslySetInnerHTML={{ __html: compareBars(m.impliedUp, wagerUp) }}
      />
      {hasBook && (
        <div class="detail" style={{ marginTop: '6px' }}>
          Book (Up token):{' '}
          {m.upBestBid !== undefined ? cents(m.upBestBid) : '—'} bid /{' '}
          {m.upBestAsk !== undefined ? cents(m.upBestAsk) : '—'} ask
        </div>
      )}
      <div class={`edge ${edgeUp ? 'up' : 'down'}`}>{edgeText}</div>
      <PaperVerdict r={r} />
      <div class="detail" style={{ marginTop: '6px' }}>
        {note}
      </div>
    </div>
  );
}

function PaperVerdict({ r }: { r: RangePrediction }) {
  const pd = r.paper;
  if (!pd) return null;
  if (pd.action === 'BET') {
    const sized =
      pd.stake !== undefined
        ? `bet ${fmtUsd2(pd.stake)} to win ${fmtUsd2((pd.stake * (1 - pd.cost!)) / pd.cost!)}`
        : `bet ${(pd.stakeFraction * 100).toFixed(1)}% of bankroll`;
    return (
      <div class="detail" style={{ marginTop: '8px' }}>
        <span class="paper-chip bet">PAPER BET</span>
        {`${sized} · ${pd.side} at ${cents(pd.cost!)} · edge +${cents(pd.edge!)} · ${(pd.stakeFraction * 100).toFixed(1)}% bankroll`}
      </div>
    );
  }
  const why =
    pd.reason === 'no-book'
      ? 'no order book at commit'
      : `edge ${pd.edge !== undefined && pd.edge >= 0 ? '+' : ''}${
          pd.edge !== undefined ? cents(pd.edge) : '—'
        } below minimum`;
  return (
    <div class="detail" style={{ marginTop: '8px' }}>
      <span class="paper-chip pass">NO BET</span>
      {why}
    </div>
  );
}

export function DetailPanel() {
  const p = latest.value;
  const r = p?.ranges.find(x => x.id === selectedTab.value) ?? p?.ranges[0];
  if (!p || !r) return <div class="card detail-panel"></div>;

  const up = r.probUp;
  const tkr = CRYPTOS[r.crypto]?.ticker ?? 'BTC';
  const c = r.committed;
  const verdictUp = c ? c.side === 'UP' : up >= 0.5;
  const upPct = Math.round(up * 100);
  const beatWord = r.strikeIsProxy ? '≈ price to beat' : 'price to beat';

  const pts = lastMinutes(p.history, CHART_MINUTES[r.id]);
  const lastPt = pts[pts.length - 1];
  const chartColor =
    lastPt && lastPt.price >= r.strike ? COLORS.up : COLORS.down;
  let chartTip;
  if (pts.length >= 2) {
    const t0 = pts[0]!.t;
    const span = pts[pts.length - 1]!.t - t0 || 1;
    chartTip = {
      xs: pts.map(pt => ((pt.t - t0) / span) * 100),
      at: (i: number) => {
        const pt = pts[i]!;
        const diff = pt.price - r.strike;
        return {
          title: new Date(pt.t).toLocaleTimeString(),
          rows: [
            { label: 'Price', value: fmtUsd2(pt.price), color: chartColor },
            {
              label: 'vs strike',
              value: `${diff >= 0 ? '+' : ''}${fmtUsd2(diff)}`,
              color: diff >= 0 ? COLORS.up : COLORS.down,
            },
          ],
        };
      },
    };
  }

  const calib = r.calibration?.active
    ? (() => {
        const delta = Math.round((r.probUp - r.rawProbUp) * 100);
        const adj =
          delta === 0
            ? 'no adjustment'
            : `${delta > 0 ? '+' : ''}${delta} pts vs raw ${fmtPct(r.rawProbUp)}`;
        return `Calibrated on ${r.calibration!.samples} resolved calls · ${adj}`;
      })()
    : `Uncalibrated · learning (${r.calibration?.samples ?? 0} resolved calls so far)`;

  return (
    <div class="card detail-panel">
      <div class="detail-head">
        <div>
          <div class="card-title">
            <span>Up / Down · {r.label}</span>
            <span class="src-tag">
              {r.resolutionSource === 'chainlink'
                ? `Chainlink ${tkr}/USD`
                : `Binance ${tkr}/USDT`}
            </span>
          </div>
          <div class="detail-window">
            {fmtClock(r.windowStart)} → {fmtClock(r.windowEnd)} · closes{' '}
            {relTime(r.windowEnd)}
          </div>
          <div
            class={
              c
                ? `detail-window committed ${c.side === 'UP' ? 'up' : 'down'}`
                : 'detail-window committed muted'
            }
          >
            {c
              ? `Committed ${c.side} ${fmtPct(c.confidence)} · locked at ${fmtClock(c.decidedAt)} (${c.horizonMinutes.toFixed(1)}m left)`
              : 'No committed call — window opened before tracking began'}
          </div>
        </div>
        <div class="detail-side">
          <span class={`verdict ${verdictUp ? 'up' : 'down'}`}>
            {verdictUp ? 'UP' : 'DOWN'}
          </span>
          <Countdown class="countdown" end={r.windowEnd} />
          <div class="countdown-label">until close</div>
        </div>
      </div>

      <div class="detail">
        Live read · converges to the outcome as the window closes
      </div>
      <div class="split">
        <div class="up" style={{ width: `${upPct}%` }}></div>
        <div class="down" style={{ width: `${100 - upPct}%` }}></div>
      </div>
      <div class="split-labels">
        <span class="up">Up {fmtPct(up)}</span>
        <span class="down">Down {fmtPct(1 - up)}</span>
      </div>

      <div class="detail beat">
        vs {fmtUsd2(r.strike)} ({beatWord})
      </div>
      <Chart
        class="chart tall"
        svg={sparkline(pts, chartColor, { strike: r.strike })}
        tip={chartTip}
      />

      <div class="stat-row">
        <div class="stat">
          <div class="detail">P(close ≥ price to beat)</div>
          <div class="big accent">{fmtPct(r.probUp)}</div>
          <div class="detail">{calib}</div>
        </div>
        <div class="stat">
          <div class="detail">Forecast close · 95% band</div>
          <div class="big">{fmtUsd(r.forecast.point)}</div>
          <div class="detail">
            {fmtUsd(r.forecast.low)} – {fmtUsd(r.forecast.high)}
          </div>
        </div>
      </div>

      <MarketBlock r={r} />
    </div>
  );
}
