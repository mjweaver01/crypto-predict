// Main-thread client for the analytics worker (compute.worker.ts). Spawns a
// single long-lived worker lazily and multiplexes jobs over it by id. If the
// worker dies, every in-flight job rejects and the next call respawns it — so a
// crash degrades to a one-off error (callers serve stale via the cache) rather
// than a permanent outage.

import type { CalibratorFit } from '../model/calibration.ts';
import type { MetricsResponse, PaperResponse } from '../../shared/types.ts';

interface JobResult {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL('./compute.worker.ts', import.meta.url).href, {
    type: 'module',
  });
  w.addEventListener('message', (ev: MessageEvent<JobResult>) => {
    const { id, ok, result, error } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok) p.resolve(result);
    else p.reject(new Error(error ?? 'compute worker error'));
  });
  w.addEventListener('error', ev => {
    failAll(ev.message || 'compute worker crashed');
    w.terminate();
    if (worker === w) worker = null;
  });
  worker = w;
  return w;
}

type JobKind = 'paper' | 'metrics' | 'bankroll' | 'calibrate';

function run<T>(
  kind: JobKind,
  crypto?: string,
  from?: number,
  to?: number
): Promise<T> {
  const w = getWorker();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    w.postMessage({ id, kind, crypto, from, to });
  });
}

export const runPaper = (crypto?: string, from?: number, to?: number) =>
  run<PaperResponse>('paper', crypto, from, to);

export const runMetrics = (crypto?: string, from?: number, to?: number) =>
  run<MetricsResponse>('metrics', crypto, from, to);

export const runBankroll = () => run<number>('bankroll');

export const runCalibrate = () => run<CalibratorFit[]>('calibrate');
