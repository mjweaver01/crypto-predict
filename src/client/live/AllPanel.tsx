// The All view's detail card: every crypto's call/bet for the selected window
// family, in one table. Clicking a row focuses that asset.

import type { Prediction, RangePrediction } from '../../shared/types.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import { fmtClock, fmtPct, fmtPx, fmtUsd2, relTime } from '../format.ts';
import { selectedCrypto } from '../crypto.ts';
import { latestAll, selectedTab } from './state.ts';
import { Countdown } from './Countdown.tsx';

const cents = (v: number) => `${(v * 100).toFixed(1)}¢`;

function Verdict({ r }: { r: RangePrediction }) {
  const pd = r.paper;
  if (pd?.action === 'BET') {
    return (
      <>
        <span class="paper-chip bet">BET</span>{' '}
        {pd.stake !== undefined ? fmtUsd2(pd.stake) : ''}{' '}
        <span class="edge-pos">
          +{pd.edge !== undefined ? cents(pd.edge) : '—'}
        </span>
      </>
    );
  }
  if (pd) return <span class="paper-chip pass">PASS</span>;
  return <>—</>;
}

export function AllPanel() {
  const preds = latestAll.value;
  if (!preds) return <div class="card detail-panel"></div>;
  const id = selectedTab.value;
  const rows = preds
    .map(p => ({ p, r: p.ranges.find(r => r.id === id) }))
    .filter((x): x is { p: Prediction; r: RangePrediction } => !!x.r);
  if (rows.length === 0) return <div class="card detail-panel"></div>;
  const first = rows[0]!.r;

  const betsOn = rows.filter(x => x.r.paper?.action === 'BET');
  const committed = rows.filter(x => x.r.committed).length;
  const summary =
    `${committed}/${rows.length} calls committed · ${betsOn.length} paper bet${betsOn.length === 1 ? '' : 's'}` +
    ' · click a row to focus that crypto';

  return (
    <div class="card detail-panel">
      <div class="detail-head">
        <div>
          <div class="card-title">
            <span>Up / Down · {first.label} · every crypto</span>
          </div>
          <div class="detail-window">
            {fmtClock(first.windowStart)} → {fmtClock(first.windowEnd)} · closes{' '}
            {relTime(first.windowEnd)}
          </div>
        </div>
        <div class="detail-side">
          <Countdown class="countdown" end={first.windowEnd} />
          <div class="countdown-label">until close</div>
        </div>
      </div>
      <div class="detail">{summary}</div>
      <div class="all-table-wrap">
        <table class="all-table">
          <thead>
            <tr>
              <th>Asset</th>
              <th>Spot</th>
              <th>Call</th>
              <th>Model ↑</th>
              <th>Market ↑</th>
              <th>Strike</th>
              <th>Paper</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, r }) => {
              const meta = CRYPTOS[p.crypto];
              const c = r.committed;
              const side = c?.side ?? (r.probUp >= 0.5 ? 'UP' : 'DOWN');
              const vs = p.stats.price >= r.strike ? '↑' : '↓';
              return (
                <tr
                  key={p.crypto}
                  onClick={() => {
                    selectedCrypto.value = p.crypto;
                  }}
                >
                  <td>
                    <b>{meta.ticker}</b>
                  </td>
                  <td>{fmtPx(p.stats.price)}</td>
                  <td>
                    <span
                      class={`side-chip ${side === 'UP' ? 'up' : 'down'}${c ? '' : ' tentative'}`}
                    >
                      {side}
                    </span>
                    {c ? ` ${fmtPct(c.confidence)}` : ''}
                  </td>
                  <td>{fmtPct(r.probUp)}</td>
                  <td>{r.market ? fmtPct(r.market.impliedUp) : '—'}</td>
                  <td>
                    {fmtPx(r.strike)}{' '}
                    <span style={{ color: 'var(--text-dim)' }}>{vs}</span>
                  </td>
                  <td>
                    <Verdict r={r} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
