// Shared top bar: brand, the (reactive) crypto selector, page nav, the live
// "updated" timestamp, and the LIVE TRADING badge. `page` selects which nav
// link is active and which "updated" signal to show.

import type { ComponentChildren } from 'preact';
import { CryptoSelect } from './CryptoSelect.tsx';

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
        <CryptoSelect />
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
