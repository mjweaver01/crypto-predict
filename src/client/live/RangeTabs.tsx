// The tab strip, one per Polymarket Up/Down family. In single-asset mode each
// tab shows that family's committed (or live-lean) side + a BET pill; in the
// All view each tab aggregates how many cryptos have a paper bet on that family.

import type { Prediction, RangePrediction } from '../../shared/types.ts';
import { fmtPct } from '../format.ts';
import { selectedCrypto } from '../crypto.ts';
import { RANGE_IDS, latest, latestAll, selectedTab } from './state.ts';
import { Countdown } from './Countdown.tsx';

function SingleTabs({ p }: { p: Prediction }) {
  return (
    <>
      {p.ranges.map(r => {
        const active = r.id === selectedTab.value ? ' active' : '';
        const sub = r.market
          ? `mkt ${fmtPct(r.market.impliedUp)}`
          : 'model only';
        const side = r.committed?.side ?? (r.probUp >= 0.5 ? 'UP' : 'DOWN');
        const chipCls = `tab-side ${side === 'UP' ? 'up' : 'down'}${r.committed ? '' : ' tentative'}`;
        return (
          <button
            key={r.id}
            class={`tab${active}`}
            role="tab"
            onClick={() => {
              selectedTab.value = r.id;
            }}
          >
            <span class="tab-top">
              <span class="tab-label">{r.label}</span>
              <span class="tab-badges">
                <span class={chipCls}>{side}</span>
                {r.paper?.action === 'BET' && (
                  <span class="paper-chip bet">BET</span>
                )}
              </span>
            </span>
            <Countdown class="tab-timer" end={r.windowEnd} />
            <span class="tab-sub">{sub}</span>
          </button>
        );
      })}
    </>
  );
}

function AllTabs({ preds }: { preds: Prediction[] }) {
  return (
    <>
      {RANGE_IDS.map(id => {
        const rs = preds
          .map(p => p.ranges.find(r => r.id === id))
          .filter((r): r is RangePrediction => !!r);
        if (rs.length === 0) return null;
        const bets = rs.filter(r => r.paper?.action === 'BET').length;
        const active = id === selectedTab.value ? ' active' : '';
        return (
          <button
            key={id}
            class={`tab${active}`}
            role="tab"
            onClick={() => {
              selectedTab.value = id;
            }}
          >
            <span class="tab-top">
              <span class="tab-label">{rs[0]!.label}</span>
              <span class={`tab-side ${bets > 0 ? 'up' : 'tentative'}`}>
                {bets} bet{bets === 1 ? '' : 's'}
              </span>
            </span>
            <Countdown class="tab-timer" end={rs[0]!.windowEnd} />
            <span class="tab-sub">{rs.length} markets</span>
          </button>
        );
      })}
    </>
  );
}

export function RangeTabs() {
  const all = selectedCrypto.value === 'all';
  if (all) {
    const preds = latestAll.value;
    if (!preds) return <div class="tabs" role="tablist"></div>;
    return (
      <div class="tabs" role="tablist">
        <AllTabs preds={preds} />
      </div>
    );
  }
  const p = latest.value;
  if (!p) return <div class="tabs" role="tablist"></div>;
  return (
    <div class="tabs" role="tablist">
      <SingleTabs p={p} />
    </div>
  );
}
