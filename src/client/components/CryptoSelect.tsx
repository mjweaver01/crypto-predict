// Custom crypto dropdown with icon badges (native <select> can't render icons).
// Drives the shared `selectedCrypto` signal; used in both page headers.

import { useEffect, useRef, useState } from 'preact/hooks';
import { CRYPTOS, CRYPTO_IDS } from '../../shared/cryptos.ts';
import { selectedCrypto, type CryptoChoice } from '../crypto.ts';
import { CryptoIcon } from './CryptoIcon.tsx';

export function CryptoSelect() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const cur = selectedCrypto.value;
  const choose = (c: CryptoChoice) => {
    selectedCrypto.value = c;
    setOpen(false);
  };

  return (
    <div class="crypto-select-wrap" ref={rootRef}>
      <button
        class="crypto-select-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <CryptoIcon id={cur} />
        <span class="crypto-select-label">
          {cur === 'all' ? 'All cryptos' : CRYPTOS[cur].label}
        </span>
        <span class="crypto-select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div class="crypto-menu" role="listbox">
          <button
            class={`crypto-opt${cur === 'all' ? ' active' : ''}`}
            role="option"
            aria-selected={cur === 'all'}
            onClick={() => choose('all')}
          >
            <CryptoIcon id="all" />
            <span class="crypto-opt-name">All cryptos</span>
          </button>
          {CRYPTO_IDS.map(id => (
            <button
              key={id}
              class={`crypto-opt${cur === id ? ' active' : ''}`}
              role="option"
              aria-selected={cur === id}
              onClick={() => choose(id)}
            >
              <CryptoIcon id={id} />
              <span class="crypto-opt-name">{CRYPTOS[id].label}</span>
              <span class="crypto-opt-ticker">{CRYPTOS[id].ticker}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
