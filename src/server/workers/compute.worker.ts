// Off-main-thread analytics. The paper-trading replay and the learning-curve
// metrics each walk the entire (multi-thousand-row) ledger, which is pure CPU
// and — run on the server's single JS thread — freezes every other request
// (including the HTML/JS for a page refresh) until it finishes. This worker runs
// those passes in a separate thread so the main event loop stays responsive.
//
// The worker owns its OWN copy of the ledger, re-read from disk on a short TTL.
// It never shares state with the main process, so there's no locking: history
// views tolerate a couple seconds of staleness, and the bankroll only moves as
// bets resolve (already persisted).

import { getLedger, reloadLedger } from '../model/ledger.ts';
import { simulatePaper } from '../model/paper.ts';
import { computeMetrics } from '../model/metrics.ts';
import { fitAllCalibrators } from '../model/calibration.ts';
import type { LedgerEntry } from '../../shared/types.ts';

interface JobMessage {
  id: number;
  kind: 'paper' | 'metrics' | 'bankroll' | 'calibrate';
  crypto?: string;
  from?: number;
  to?: number;
}

interface WorkerScope {
  onmessage: ((ev: MessageEvent<JobMessage>) => void) | null;
  postMessage(msg: unknown): void;
}
const scope = self as unknown as WorkerScope;

const inCrypto = (crypto: string | undefined, rowCrypto: string | undefined) =>
  !crypto || (rowCrypto ?? 'btc') === crypto;

// Re-read the ledger file at most this often; between reads we reuse the parsed
// copy (getLedger() memoizes). Cheap parses, all on this thread.
const LEDGER_TTL_MS = 2_000;
let lastLoad = 0;
async function freshEntries(): Promise<LedgerEntry[]> {
  if (Date.now() - lastLoad > LEDGER_TTL_MS) {
    reloadLedger();
    lastLoad = Date.now();
  }
  return getLedger();
}

function inRange(e: LedgerEntry, from?: number, to?: number): boolean {
  if (from === undefined && to === undefined) return true;
  const t = Date.parse(e.windowStart);
  return (from === undefined || t >= from) && (to === undefined || t <= to);
}

scope.onmessage = async (ev: MessageEvent<JobMessage>) => {
  const { id, kind, crypto, from, to } = ev.data;
  try {
    let result: unknown;
    if (kind === 'metrics') {
      // computeMetrics() reads the ledger itself; prime the fresh copy first.
      await freshEntries();
      result = await computeMetrics(crypto, from, to);
    } else if (kind === 'calibrate') {
      result = fitAllCalibrators(await freshEntries());
    } else {
      const all = (await freshEntries()).filter(e => inCrypto(crypto, e.crypto));
      const entries = all.filter(e => inRange(e, from, to));
      const paper = simulatePaper(entries);
      result = kind === 'bankroll' ? paper.summary.bankroll : paper;
    }
    scope.postMessage({ id, ok: true, result });
  } catch (err) {
    scope.postMessage({ id, ok: false, error: String(err) });
  }
};
