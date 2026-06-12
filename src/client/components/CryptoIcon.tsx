// Small round brand-colored badge for each asset (and a multi-color "all"
// variant). Used in the crypto dropdown — native <option> can't hold markup, so
// the selector is a custom component (see CryptoSelect).

import type { CryptoId } from '../../shared/cryptos.ts';
import type { CryptoChoice } from '../crypto.ts';

const ICONS: Record<CryptoId, { bg: string; fg: string; glyph: string }> = {
  btc: { bg: '#f7931a', fg: '#fff', glyph: '₿' },
  eth: { bg: '#627eea', fg: '#fff', glyph: 'Ξ' },
  sol: { bg: '#9945ff', fg: '#fff', glyph: 'S' },
  xrp: { bg: '#23292f', fg: '#fff', glyph: 'X' },
  doge: { bg: '#c2a633', fg: '#1a1a1a', glyph: 'Ð' },
  bnb: { bg: '#f3ba2f', fg: '#1a1a1a', glyph: 'B' },
};

const ALL_BG =
  'conic-gradient(from 210deg, #f7931a, #627eea, #9945ff, #c2a633, #f7931a)';

export function CryptoIcon({ id }: { id: CryptoChoice }) {
  if (id === 'all') {
    return (
      <span class="crypto-icon crypto-icon-all" style={{ background: ALL_BG }} aria-hidden="true" />
    );
  }
  const ic = ICONS[id];
  return (
    <span
      class="crypto-icon"
      style={{ background: ic.bg, color: ic.fg }}
      aria-hidden="true"
    >
      {ic.glyph}
    </span>
  );
}
