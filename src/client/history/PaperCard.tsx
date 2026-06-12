// Paper-trading scoreboard: the EV policy replayed over every resolved call at
// real commit-time order-book costs. Overall mode charts the compounding
// bankroll; a per-family filter charts that family's cumulative P&L instead.

import type { ComponentChildren, JSX } from 'preact';
import type { PaperBet, PaperResponse } from '../../shared/types.ts';
import { COLORS, fmtDateTime, fmtDay, fmtPct, fmtUsd2 } from '../format.ts';
import { isoOf, paperChart, seriesXs } from '../charts.ts';
import { Chart } from '../components/Chart.tsx';
import { RECORD_RANGES, paper, recordFilter } from './state.ts';

function PaperBetRow({ b }: { b: PaperBet }) {
  const result =
    b.pnl === undefined ? (
      <span class="rec-result pending" title="Awaiting resolution">
        ···
      </span>
    ) : b.won ? (
      <span class="rec-result hit" title="Won">
        ✓
      </span>
    ) : (
      <span class="rec-result miss" title="Lost">
        ✗
      </span>
    );
  return (
    <div class="pt-bet">
      {result}
      <span class="rec-range">{b.rangeId}</span>
      <span class="pt-when">{fmtDateTime(b.decidedAt)}</span>
      <span class={`rec-side ${b.side === 'UP' ? 'up' : 'down'}`}>
        {b.side}
      </span>
      <span class="pt-num">
        at {(b.cost * 100).toFixed(1)}¢ (edge +{(b.edge * 100).toFixed(1)}¢)
      </span>
      <span class="pt-num">bet {fmtUsd2(b.stake)}</span>
      {b.pnl === undefined ? (
        <span class="pt-pnl">
          to win {fmtUsd2((b.stake * (1 - b.cost)) / b.cost)}
        </span>
      ) : (
        <span class={`pt-pnl ${b.pnl >= 0 ? 'up' : 'down'}`}>
          {b.pnl >= 0 ? '+' : ''}
          {fmtUsd2(b.pnl)}
        </span>
      )}
      {b.bankrollAfter !== undefined ? (
        <span class="pt-bank">bank {fmtUsd2(b.bankrollAfter)}</span>
      ) : (
        <span class="pt-bank">open</span>
      )}
    </div>
  );
}

function Legend({ p }: { p: PaperResponse }) {
  return (
    <div class="hr-legend">
      {p.families.map(f => {
        const sgn = f.pnl >= 0 ? '+' : '';
        return (
          <span class="key" key={f.rangeId}>
            <span
              class="swatch"
              style={{ background: f.pnl >= 0 ? COLORS.up : COLORS.down }}
            ></span>
            {f.rangeId}: {sgn}
            {fmtUsd2(f.pnl)} ({f.wins}/{f.bets}, roi {fmtPct(f.roi)})
          </span>
        );
      })}
    </div>
  );
}

function Shell({
  sub,
  children,
}: {
  sub: string;
  children?: ComponentChildren;
}) {
  return (
    <div class="card hr-card">
      <div class="hr-top">
        <div>
          <span class="card-title">
            <span>Paper trading · real order-book costs</span>
          </span>
          <div class="record-sub">{sub}</div>
        </div>
        <div class="record-stats">{/* filled by children variants */}</div>
      </div>
      {children}
    </div>
  );
}

export function PaperCard() {
  const p = paper.value;
  if (!p) {
    return (
      <Shell sub="—">
        <div class="chart hr-chart">
          <div class="chart-empty"></div>
        </div>
        <div class="hr-axis"></div>
        <div class="hr-legend"></div>
        <div class="pt-bets"></div>
      </Shell>
    );
  }

  const s = p.summary;
  const pol = p.policy;
  const rf = recordFilter.value;
  const famFilter = rf !== 'ALL';
  const meTxt = famFilter
    ? `min edge ${(pol.minEdge[rf] * 100).toFixed(0)}¢`
    : `min edge ${RECORD_RANGES.map(id => (pol.minEdge[id] * 100).toFixed(0)).join('/')}¢ (${RECORD_RANGES.join('/')})`;
  const polTxt = `${meTxt} · ${(pol.kellyFraction * 100).toFixed(0)}% Kelly, ≤${(pol.maxStakeFraction * 100).toFixed(0)}%/bet`;
  const bets = famFilter ? p.bets.filter(b => b.rangeId === rf) : p.bets;
  const open = famFilter ? p.open.filter(b => b.rangeId === rf) : p.open;

  const MAX_ROWS = 30;
  const listRows = [...open, ...bets].slice(0, MAX_ROWS);
  const list = (
    <div class="pt-bets">
      {listRows.map(b => (
        <PaperBetRow key={b.id} b={b} />
      ))}
      {open.length + bets.length > MAX_ROWS && (
        <div class="pt-more">
          showing {MAX_ROWS} of {open.length + bets.length} bets
        </div>
      )}
    </div>
  );

  if (bets.length === 0) {
    const sub =
      `No resolved paper bets${famFilter ? ` for ${rf}` : ''} yet · ` +
      `${open.length} open · ${polTxt} — accumulates as commits with real bid/ask resolve.`;
    return (
      <div class="card hr-card">
        <div class="hr-top">
          <div>
            <span class="card-title">
              <span>Paper trading · real order-book costs</span>
            </span>
            <div class="record-sub">{sub}</div>
          </div>
          <div class="record-stats"></div>
        </div>
        <div class="chart hr-chart">
          <div class="chart-empty"></div>
        </div>
        <div class="hr-axis"></div>
        <div class="hr-legend"></div>
        {list}
      </div>
    );
  }

  let sub: string;
  let stats: JSX.Element;
  let chartSvg: string;
  let chartTip;
  let axis: JSX.Element;

  if (famFilter) {
    const f = p.families.find(x => x.rangeId === rf);
    const wins = bets.filter(b => b.won).length;
    sub = `${rf}: ${bets.length} bets (${wins}W–${bets.length - wins}L) · ${open.length} open · ${polTxt}`;
    const pnl = f?.pnl ?? 0;
    const sign = pnl >= 0 ? '+' : '';
    stats = (
      <div class="record-stats">
        <div>
          <div class="rstat-label">P&amp;L</div>
          <div
            class="rstat-val"
            style={{ color: pnl >= 0 ? COLORS.up : COLORS.down }}
          >
            {sign}
            {fmtUsd2(pnl)}
          </div>
        </div>
        <div>
          <div class="rstat-label">Staked</div>
          <div class="rstat-val">{fmtUsd2(f?.staked ?? 0)}</div>
        </div>
        <div>
          <div class="rstat-label">ROI</div>
          <div class="rstat-val">{fmtPct(f?.roi ?? 0)}</div>
        </div>
        <div>
          <div class="rstat-label">Win rate</div>
          <div class="rstat-val accent">
            {fmtPct(bets.length ? wins / bets.length : 0)}
          </div>
        </div>
      </div>
    );
    let cum = 0;
    const ordered = [...bets].reverse();
    const series = ordered.map(b => (cum += b.pnl ?? 0));
    chartSvg = paperChart([0, ...series], 0);
    chartTip = {
      xs: seriesXs(series.length + 1),
      at: (i: number) => {
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
    };
    axis = (
      <div class="hr-axis">
        <span class="hl">cumulative {rf} P&L per resolved bet</span>
      </div>
    );
  } else {
    sub =
      `${s.bets} bets (${s.wins}W–${s.bets - s.wins}L) · ${s.passes} passes · ${open.length} open · ` +
      `book: ${s.sources.live} live, ${s.sources.trades} backfilled · ${polTxt}`;
    const sign = s.pnl >= 0 ? '+' : '';
    stats = (
      <div class="record-stats">
        <div>
          <div class="rstat-label">Bankroll</div>
          <div class="rstat-val accent">{fmtUsd2(s.bankroll)}</div>
        </div>
        <div>
          <div class="rstat-label">P&amp;L</div>
          <div
            class="rstat-val"
            style={{ color: s.pnl >= 0 ? COLORS.up : COLORS.down }}
          >
            {sign}
            {fmtUsd2(s.pnl)}
          </div>
        </div>
        <div>
          <div class="rstat-label">ROI</div>
          <div class="rstat-val">{fmtPct(s.roi)}</div>
        </div>
        <div>
          <div class="rstat-label">Max DD</div>
          <div class="rstat-val">{fmtPct(s.maxDrawdown)}</div>
        </div>
      </div>
    );
    chartSvg = paperChart(
      p.equity.map(x => x.bankroll),
      pol.startBankroll
    );
    const orderedAll = [...p.bets].reverse();
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
    chartTip = {
      xs: seriesXs(p.equity.length),
      at: (i: number) => {
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
    };
    axis = (
      <div class="hr-axis">
        {p.equity.length >= 2 ? (
          <>
            <span>{fmtDay(p.equity[0]!.t)}</span>
            <span class="hl">bankroll per resolved bet</span>
            <span>{fmtDay(p.equity[p.equity.length - 1]!.t)}</span>
          </>
        ) : (
          <span>Not enough resolved bets to chart yet.</span>
        )}
      </div>
    );
  }

  return (
    <div class="card hr-card">
      <div class="hr-top">
        <div>
          <span class="card-title">
            <span>Paper trading · real order-book costs</span>
          </span>
          <div class="record-sub">{sub}</div>
        </div>
        {stats}
      </div>
      <Chart class="chart hr-chart" svg={chartSvg} tip={chartTip} />
      {axis}
      <Legend p={p} />
      {list}
    </div>
  );
}
