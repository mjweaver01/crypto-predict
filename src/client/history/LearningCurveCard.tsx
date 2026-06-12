// Prequential learning curve: rolling Brier of the calibrated (bet-on)
// probability vs the frozen raw model vs the market, for the active family.

import { COLORS, fmtDateTime, fmtDay, fmtPct } from '../format.ts';
import { isoOf, learningChart, seriesXs } from '../charts.ts';
import { Chart } from '../components/Chart.tsx';
import { metrics, recordFilter } from './state.ts';

export function LearningCurveCard() {
  const f = metrics.value?.families.find(x => x.family === recordFilter.value);

  if (!f || f.rolling.n === 0) {
    return (
      <div class="card hr-card">
        <div class="hr-top">
          <div>
            <span class="card-title">
              <span>Learning curve · Brier (lower is better)</span>
            </span>
            <div class="record-sub">—</div>
          </div>
          <div class="record-stats"></div>
        </div>
        <div class="chart hr-chart">
          <div class="chart-empty"></div>
        </div>
        <div class="hr-axis">
          <span>Not enough resolved calls yet.</span>
        </div>
        <div class="hr-legend"></div>
      </div>
    );
  }

  const r = f.rolling;
  const edge = r.brierRaw - r.brierCal;
  const tip = {
    xs: seriesXs(f.series.length),
    at: (i: number) => {
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
  };

  return (
    <div class="card hr-card">
      <div class="hr-top">
        <div>
          <span class="card-title">
            <span>Learning curve · Brier (lower is better)</span>
          </span>
          <div class="record-sub">
            {`last ${r.n} resolved calls · learned edge ${edge >= 0 ? '+' : ''}${(edge * 1000).toFixed(1)} mBrier`}
          </div>
        </div>
        <div class="record-stats">
          <div>
            <div class="rstat-label">Calibrated</div>
            <div class="rstat-val accent">{r.brierCal.toFixed(3)}</div>
          </div>
          <div>
            <div class="rstat-label">Raw model</div>
            <div class="rstat-val">{r.brierRaw.toFixed(3)}</div>
          </div>
          {r.brierMkt !== undefined && (
            <div>
              <div class="rstat-label">Market (n={r.nMkt})</div>
              <div class="rstat-val">{r.brierMkt.toFixed(3)}</div>
            </div>
          )}
        </div>
      </div>
      <Chart class="chart hr-chart" svg={learningChart(f)} tip={tip} />
      <div class="hr-axis">
        {f.series.length >= 2 ? (
          <>
            <span>{fmtDay(f.series[0]!.t)}</span>
            <span class="hl">rolling {f.window}-call Brier</span>
            <span>{fmtDay(f.series[f.series.length - 1]!.t)}</span>
          </>
        ) : (
          <span>Not enough resolved calls to chart yet.</span>
        )}
      </div>
      <div class="hr-legend">
        <span class="key">
          <span class="swatch" style={{ background: COLORS.accent }}></span>
          Calibrated (bet on)
        </span>
        <span class="key">
          <span class="swatch" style={{ background: COLORS.muted }}></span>
          Raw model
        </span>
        <span class="key">
          <span class="swatch dashed"></span>0.25 coin-flip
        </span>
      </div>
    </div>
  );
}
