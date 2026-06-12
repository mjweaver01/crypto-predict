// Hit rate over time: windowed headline accuracy/Brier (with an all-time
// reference), the family filter strip (all-time badges), and the accuracy chart
// drawn from the date-filtered metrics series (cumulative + recent form).

import { COLORS, fmtDateTime, fmtDay, fmtPct } from '../format.ts';
import { hitRateChartFromSeries, isoOf, seriesXs } from '../charts.ts';
import { Chart } from '../components/Chart.tsx';
import {
  DATE_PRESET_LABELS,
  RECORD_RANGES,
  datePreset,
  ledgerFilteredSummary,
  ledgerSummary,
  metrics,
  recordFilter,
} from './state.ts';

export function HitRateCard() {
  const all = ledgerSummary.value;
  const s = ledgerFilteredSummary.value ?? all;
  const f = metrics.value?.families.find(x => x.family === recordFilter.value);
  const pts = f?.series ?? [];
  const windowLabel =
    datePreset.value === 'all' ? 'all time' : DATE_PRESET_LABELS[datePreset.value];

  const showAllTime = !!(all && all !== s && all.resolved);

  const tip =
    pts.length >= 2
      ? {
          xs: seriesXs(pts.length),
          at: (i: number) => {
            const p = pts[i]!;
            return {
              title: fmtDateTime(isoOf(p.t)),
              rows: [
                {
                  label: `Recent (last ${f!.window})`,
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
        }
      : undefined;

  return (
    <div class="card hr-card">
      <div class="hr-top">
        <div>
          <span class="card-title">
            <span>Hit rate over time</span>
          </span>
          <div class="record-sub">
            {s
              ? `${s.resolved} resolved of ${s.total} calls · ${s.correct} correct · ${windowLabel}`
              : '—'}
          </div>
        </div>
        <div class="record-stats">
          <div>
            <div class="rstat-label">Hit rate</div>
            <div class="rstat-val accent">
              {s && s.resolved ? fmtPct(s.accuracy) : '—'}
              {showAllTime && (
                <span class="rstat-alltime"> ({fmtPct(all!.accuracy)} all time)</span>
              )}
            </div>
          </div>
          <div>
            <div class="rstat-label">Brier</div>
            <div class="rstat-val">
              {s && s.resolved ? s.brier.toFixed(3) : '—'}
            </div>
          </div>
        </div>
      </div>

      <div class="record-filters">
        <button
          class={recordFilter.value === 'ALL' ? 'active' : ''}
          onClick={() => {
            recordFilter.value = 'ALL';
          }}
        >
          All
          <span class="rf-acc">{all && all.resolved ? fmtPct(all.accuracy) : '—'}</span>
        </button>
        {RECORD_RANGES.map(id => {
          const r = all?.byRange[id];
          return (
            <button
              key={id}
              class={recordFilter.value === id ? 'active' : ''}
              onClick={() => {
                recordFilter.value = id;
              }}
            >
              {id}
              <span class="rf-acc">{r && r.resolved ? fmtPct(r.accuracy) : '—'}</span>
            </button>
          );
        })}
      </div>

      {pts.length >= 2 ? (
        <>
          <Chart class="chart hr-chart" svg={hitRateChartFromSeries(pts)} tip={tip} />
          <div class="hr-axis">
            <span>{fmtDay(pts[0]!.t)}</span>
            <span class="hl">100% / 50% / 0%</span>
            <span>{fmtDay(pts[pts.length - 1]!.t)}</span>
          </div>
          <div class="hr-legend">
            <span class="key">
              <span class="swatch" style={{ background: COLORS.accent }}></span>
              Recent form (last {f!.window})
            </span>
            <span class="key">
              <span class="swatch" style={{ background: COLORS.muted }}></span>
              Cumulative
            </span>
            <span class="key">
              <span class="swatch dashed"></span>50% baseline
            </span>
          </div>
        </>
      ) : (
        <>
          <div class="chart hr-chart">
            <div class="chart-empty"></div>
          </div>
          <div class="hr-axis">
            <span>Not enough resolved calls to chart yet.</span>
          </div>
          <div class="hr-legend"></div>
        </>
      )}
    </div>
  );
}
