// The crypto assets whose Polymarket up/down market families we mirror. Every
// asset runs the SAME five recurring families (5m/15m/1h/4h/1d) with the same
// slug patterns and window boundaries — only the asset prefix/name differs.
// Shared between server and client.

export type CryptoId = 'btc' | 'eth' | 'sol' | 'xrp' | 'doge' | 'bnb';

export interface CryptoMeta {
  id: CryptoId;
  /** Display name, e.g. "Bitcoin". */
  label: string;
  /** Ticker shown in the UI, e.g. "BTC". */
  ticker: string;
  /** Binance spot symbol the markets settle against (1h/1d) / we model on. */
  binanceSymbol: string;
  /** Polymarket slug prefix for the 5m/15m/4h families (`btc-updown-…`). */
  pmShort: string;
  /** Polymarket slug name for the 1h/1d families (`bitcoin-up-or-down-…`). */
  pmName: string;
  /** Symbol for Polymarket's crypto-price strike API (`?symbol=BTC`). */
  pmPriceSymbol: string;
}

export const CRYPTOS: Record<CryptoId, CryptoMeta> = {
  btc: {
    id: 'btc',
    label: 'Bitcoin',
    ticker: 'BTC',
    binanceSymbol: 'BTCUSDT',
    pmShort: 'btc',
    pmName: 'bitcoin',
    pmPriceSymbol: 'BTC',
  },
  eth: {
    id: 'eth',
    label: 'Ethereum',
    ticker: 'ETH',
    binanceSymbol: 'ETHUSDT',
    pmShort: 'eth',
    pmName: 'ethereum',
    pmPriceSymbol: 'ETH',
  },
  sol: {
    id: 'sol',
    label: 'Solana',
    ticker: 'SOL',
    binanceSymbol: 'SOLUSDT',
    pmShort: 'sol',
    pmName: 'solana',
    pmPriceSymbol: 'SOL',
  },
  xrp: {
    id: 'xrp',
    label: 'XRP',
    ticker: 'XRP',
    binanceSymbol: 'XRPUSDT',
    pmShort: 'xrp',
    pmName: 'xrp',
    pmPriceSymbol: 'XRP',
  },
  doge: {
    id: 'doge',
    label: 'Dogecoin',
    ticker: 'DOGE',
    binanceSymbol: 'DOGEUSDT',
    pmShort: 'doge',
    pmName: 'dogecoin',
    pmPriceSymbol: 'DOGE',
  },
  bnb: {
    id: 'bnb',
    label: 'BNB',
    ticker: 'BNB',
    binanceSymbol: 'BNBUSDT',
    pmShort: 'bnb',
    pmName: 'bnb',
    pmPriceSymbol: 'BNB',
  },
};

export const CRYPTO_IDS: readonly CryptoId[] = [
  'btc',
  'eth',
  'sol',
  'xrp',
  'doge',
  'bnb',
];

export function isCryptoId(v: unknown): v is CryptoId {
  return typeof v === 'string' && v in CRYPTOS;
}
