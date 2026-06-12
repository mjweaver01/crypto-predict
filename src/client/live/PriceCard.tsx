// The hero spot card: price headline + 24h change + vol, the look-back range
// toggle, and either the big price chart (single asset) or the per-crypto mini
// grid (All view).

import { CRYPTOS } from '../../shared/cryptos.ts';
import { fmtPx } from '../format.ts';
import { selectedCrypto } from '../crypto.ts';
import {
  SPOT_RANGES,
  change24h,
  latest,
  selectedSpot,
  spotPrice,
} from './state.ts';
import { HeroChart } from './HeroChart.tsx';
import { MiniCards } from './MiniCards.tsx';

function RangeToggle() {
  return (
    <div class="range-toggle">
      {SPOT_RANGES.map(id => (
        <button
          key={id}
          class={id === selectedSpot.value ? 'active' : ''}
          onClick={() => {
            selectedSpot.value = id;
          }}
        >
          {id}
        </button>
      ))}
    </div>
  );
}

export function PriceCard() {
  const c = selectedCrypto.value;
  const all = c === 'all';
  const meta = CRYPTOS[c === 'all' ? 'btc' : c];
  const price = spotPrice.value;
  const change = change24h.value;
  const vol = latest.value?.stats.volPerHour;

  return (
    <div class={`card price-card${all ? ' all-mode' : ''}`}>
      <div class="price-head">
        <div>
          <div class="price-label">
            {all ? 'All cryptos · spot' : `${meta.label} price · spot`}
          </div>
          {!all && <div id="price">{price !== null ? fmtPx(price) : '$—'}</div>}
          {!all && (
            <div class="meta-row">
              <span id="change" class={`change ${(change ?? 0) >= 0 ? 'up' : 'down'}`}>
                {change !== null
                  ? `${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h`
                  : '—'}
              </span>
              <span id="vol">
                {vol !== undefined ? `σ ${(vol * 100).toFixed(2)}%/h` : '—'}
              </span>
            </div>
          )}
        </div>
        <RangeToggle />
      </div>
      {all ? <MiniCards /> : <HeroChart />}
    </div>
  );
}
