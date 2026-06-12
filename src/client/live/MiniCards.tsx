// The "All" view's per-crypto mini spot cards (shown in place of the hero
// chart). On the LIVE range each card's price/%/sparkline tracks the streamed
// tick buffer; other ranges use the server's precomputed spot series so the
// number, colour, and chart direction always agree.

import type { Prediction, PricePoint } from '../../shared/types.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import { COLORS, fmtPx } from '../format.ts';
import { sparkline } from '../charts.ts';
import { Chart } from '../components/Chart.tsx';
import { selectedCrypto } from '../crypto.ts';
import {
  latestAll,
  liveTicksByCrypto,
  selectedSpot,
  ticksVersion,
} from './state.ts';

function miniSeries(p: Prediction): PricePoint[] {
  if (selectedSpot.value === 'LIVE') {
    return liveTicksByCrypto.get(p.crypto) ?? p.history.slice(-5);
  }
  return p.spot?.[selectedSpot.value] ?? p.history.slice(-60);
}

/**
 * % change over a series (first → last). Keeping the number on the SAME span as
 * the sparkline means sign, colour, and chart direction always agree.
 */
function seriesChangePct(pts: PricePoint[]): number {
  const first = pts[0]?.price;
  const last = pts[pts.length - 1]?.price;
  return first && last ? (last / first - 1) * 100 : 0;
}

export function MiniCards() {
  const preds = latestAll.value ?? [];
  // Reading the version here subscribes the grid to tick updates, so LIVE-range
  // cards repaint as ticks arrive (the buffers themselves aren't signals).
  return (
    <div class="crypto-grid" data-v={ticksVersion.value}>
      {preds.map(p => {
        const meta = CRYPTOS[p.crypto];
        const pts = miniSeries(p);
        const pct = seriesChangePct(pts);
        const up = pct >= 0;
        return (
          <div
            class="mini-card"
            key={p.crypto}
            onClick={() => {
              selectedCrypto.value = p.crypto;
            }}
          >
            <div class="mini-ticker">{meta.ticker}/USDT</div>
            <div class="mini-price">{fmtPx(p.stats.price)}</div>
            <div class={`mini-change ${up ? 'up' : 'down'}`}>
              {up ? '+' : ''}
              {pct.toFixed(2)}% {selectedSpot.value}
            </div>
            <Chart
              class="mini-spark"
              svg={sparkline(pts, up ? COLORS.up : COLORS.down)}
            />
          </div>
        );
      })}
    </div>
  );
}
