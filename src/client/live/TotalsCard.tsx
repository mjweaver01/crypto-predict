// Cross-tab aggregate shown below AllPanel: a single set of portfolio totals
// across every crypto and every time-frame window — committed calls, paper
// bets, and the average edge on those bets.

import { fmtUsd2 } from '../format.ts';
import { latestAll } from './state.ts';

const cents = (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}¢`;

export function TotalsCard() {
  const preds = latestAll.value;
  if (!preds || preds.length === 0) return null;

  const allRanges = preds.flatMap(p => p.ranges);
  const bets = allRanges.filter(r => r.paper?.action === 'BET');
  const committed = allRanges.filter(r => r.committed).length;
  const total = allRanges.length;
  const staked = bets.reduce((s, r) => s + (r.paper?.stake ?? 0), 0);
  const avgEdge =
    bets.length > 0
      ? bets.reduce((s, r) => s + (r.paper?.edge ?? 0), 0) / bets.length
      : null;

  return (
    <div class="card detail-panel totals-card">
      <div class="detail-head">
        <div class="card-title">Portfolio totals · all windows</div>
      </div>
      <div class="totals-stats">
        <div class="totals-stat">
          <div class="totals-stat-value">
            {committed}/{total}
          </div>
          <div class="totals-stat-label">calls committed</div>
        </div>
        <div class="totals-stat">
          <div class="totals-stat-value">
            {bets.length}/{total}
          </div>
          <div class="totals-stat-label">calls bet</div>
        </div>
        <div class="totals-stat">
          <div class="totals-stat-value">
            {avgEdge === null ? (
              <span style={{ color: 'var(--text-dim)' }}>—</span>
            ) : (
              <span class={avgEdge >= 0 ? 'edge-pos' : 'edge-neg'}>
                {cents(avgEdge)}
              </span>
            )}
          </div>
          <div class="totals-stat-label">avg bet edge</div>
        </div>
        {staked > 0 && (
          <div class="totals-stat totals-stat-end">
            <div class="countdown">{fmtUsd2(staked)}</div>
            <div class="countdown-label">staked · all windows</div>
          </div>
        )}
      </div>
    </div>
  );
}
