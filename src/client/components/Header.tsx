// Shared top bar: brand, the (reactive) crypto selector, page nav, the live
// "updated" timestamp, and the LIVE TRADING badge. `page` selects which nav
// link is active and which "updated" signal to show.

import type { ComponentChildren } from 'preact';
import { CRYPTOS, CRYPTO_IDS } from '../../shared/cryptos.ts';
import { selectedCrypto, type CryptoChoice } from '../crypto.ts';

interface Props {
  page: 'live' | 'history';
  /** Reactive "updated …" text (each page owns its own clock). */
  updated: string;
  /** Show the LIVE TRADING badge (live page only). */
  liveTrading?: boolean;
  /** Extra controls rendered on the right (e.g. the history date-range bar). */
  children?: ComponentChildren;
}

export function Header({ page, updated, liveTrading, children }: Props) {
  return (
    <header>
      <div class="header-left">
        <div class="brand">Crypto Predict</div>
        <select
          class="crypto-select"
          value={selectedCrypto.value}
          onChange={e => {
            selectedCrypto.value = (e.target as HTMLSelectElement)
              .value as CryptoChoice;
          }}
        >
          <option value="all">All cryptos</option>
          {CRYPTO_IDS.map(id => (
            <option value={id}>
              {CRYPTOS[id].label} ({CRYPTOS[id].ticker})
            </option>
          ))}
        </select>
        <nav class="nav">
          <a href="/" class={page === 'live' ? 'active' : ''}>
            Live
          </a>
          <a href="/history" class={page === 'history' ? 'active' : ''}>
            History
          </a>
        </nav>
      </div>
      <div class="header-right">
        {page === 'live' && (
          <span
            class="live-trading-badge"
            style={{ display: liveTrading ? '' : 'none' }}
          >
            LIVE TRADING
          </span>
        )}
        {children}
        <div class="updated">
          updated <span>{updated || '—'}</span>
        </div>
      </div>
    </header>
  );
}
