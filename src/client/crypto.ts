// Shared, persisted crypto selection. A single signal both pages (and the
// header) read and write, so switching the asset on one page is remembered on
// the other — exactly the old loadPref/savePref('crypto') behavior, now reactive.

import { effect, signal } from '@preact/signals';
import { CRYPTO_IDS, type CryptoId } from '../shared/cryptos.ts';
import { loadPref, savePref } from './format.ts';

export type CryptoChoice = CryptoId | 'all';
export const CRYPTO_CHOICES: readonly CryptoChoice[] = [...CRYPTO_IDS, 'all'];

export const selectedCrypto = signal<CryptoChoice>(
  loadPref('crypto', CRYPTO_CHOICES, 'btc')
);

effect(() => savePref('crypto', selectedCrypto.value));

export const isAllView = () => selectedCrypto.value === 'all';
