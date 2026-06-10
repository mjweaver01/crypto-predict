// Learning-curve metrics: is the system actually getting better over time?
//
// The ledger is already a PREQUENTIAL (online, out-of-sample) record: each
// entry's `probUp` was produced by the learner in force at commit time, which
// had only seen windows resolved BEFORE that call. So scoring `probUp` against
// outcomes — and comparing it with the frozen `rawProbUp` — measures the
// learned layer's real, no-peeking contribution. We also score the
// market-implied probability over the calls that carried a quote, as an
// external benchmark.
//
// Pure function over the ledger; nothing extra is persisted.

import { getLedger } from './ledger.ts';
import type {
  FamilyMetrics,
  LedgerEntry,
  MetricsBucket,
  MetricsPoint,
  MetricsResponse,
  RangeId,
} from '../../shared/types.ts';

/** Rolling window (in resolved calls) for the "recent form" numbers/series. */
const ROLL_N = 50;
/** Max series points returned per family (decimated beyond this). */
const MAX_POINTS = 200;

interface Scored {
  t: number;
  hit: number;
  brierCal: number;
  brierRaw: number;
  brierMkt?: number;
}

function scoreEntry(e: LedgerEntry): Scored {
  const y = e.outcome === 'UP' ? 1 : 0;
  const raw = typeof e.rawProbUp === 'number' ? e.rawProbUp : e.probUp;
  return {
    t: Date.parse(e.windowStart),
    hit: e.correct ? 1 : 0,
    brierCal: (e.probUp - y) ** 2,
    brierRaw: (raw - y) ** 2,
    brierMkt:
      typeof e.marketImpliedUp === 'number'
        ? (e.marketImpliedUp - y) ** 2
        : undefined,
  };
}

function bucket(rows: Scored[]): MetricsBucket {
  const n = rows.length;
  if (n === 0) {
    return { n: 0, accuracy: 0, brierCal: 0, brierRaw: 0, nMkt: 0 };
  }
  let hit = 0;
  let cal = 0;
  let raw = 0;
  let mkt = 0;
  let nMkt = 0;
  for (const r of rows) {
    hit += r.hit;
    cal += r.brierCal;
    raw += r.brierRaw;
    if (r.brierMkt !== undefined) {
      mkt += r.brierMkt;
      nMkt++;
    }
  }
  return {
    n,
    accuracy: hit / n,
    brierCal: cal / n,
    brierRaw: raw / n,
    brierMkt: nMkt ? mkt / nMkt : undefined,
    nMkt,
  };
}

/** Rolling-mean series over the resolved sequence, decimated for charting. */
function rollingSeries(rows: Scored[]): MetricsPoint[] {
  if (rows.length < 2) return [];
  const pts: MetricsPoint[] = [];
  let hit = 0;
  let cal = 0;
  let raw = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    hit += r.hit;
    cal += r.brierCal;
    raw += r.brierRaw;
    if (i >= ROLL_N) {
      const out = rows[i - ROLL_N]!;
      hit -= out.hit;
      cal -= out.brierCal;
      raw -= out.brierRaw;
    }
    const n = Math.min(i + 1, ROLL_N);
    pts.push({
      t: r.t,
      brierCal: cal / n,
      brierRaw: raw / n,
      accuracy: hit / n,
    });
  }
  if (pts.length <= MAX_POINTS) return pts;
  const step = (pts.length - 1) / (MAX_POINTS - 1);
  return Array.from(
    { length: MAX_POINTS },
    (_, i) => pts[Math.round(i * step)]!
  );
}

function familyMetrics(family: RangeId | 'ALL', rows: Scored[]): FamilyMetrics {
  return {
    family,
    overall: bucket(rows),
    rolling: bucket(rows.slice(-ROLL_N)),
    window: ROLL_N,
    series: rollingSeries(rows),
  };
}

/** Compute learning metrics for every family plus the ALL aggregate. */
export async function computeMetrics(): Promise<MetricsResponse> {
  const entries = await getLedger();
  const resolved = entries
    .filter(e => e.outcome != null)
    .sort((a, b) => Date.parse(a.windowStart) - Date.parse(b.windowStart));

  const byFamily = new Map<RangeId, Scored[]>();
  const all: Scored[] = [];
  for (const e of resolved) {
    const s = scoreEntry(e);
    all.push(s);
    const list = byFamily.get(e.rangeId) ?? [];
    list.push(s);
    byFamily.set(e.rangeId, list);
  }

  const order: RangeId[] = ['5m', '15m', '1h', '1d'];
  return {
    families: [
      familyMetrics('ALL', all),
      ...order.map(id => familyMetrics(id, byFamily.get(id) ?? [])),
    ],
  };
}
