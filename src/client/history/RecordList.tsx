// Chronological log of calls vs realized outcomes (the persisted ledger), with
// paper-bet money joined in when the EV layer took the call.

import type { LedgerEntry } from '../../shared/types.ts';
import { fmtDateTime, fmtPct, fmtUsd2 } from '../format.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { ledgerEntries, paperById, recordFilter } from './state.ts';

function RecordRow({ e }: { e: LedgerEntry }) {
  const sideCls = e.side === 'UP' ? 'up' : 'down';
  const result =
    e.outcome == null ? (
      <span class="rec-result pending" title="Awaiting resolution">
        ···
      </span>
    ) : e.correct ? (
      <span class="rec-result hit" title="Correct">
        ✓
      </span>
    ) : (
      <span class="rec-result miss" title="Incorrect">
        ✗
      </span>
    );

  const bet = paperById.value.get(e.id);

  return (
    <div class="rec">
      {result}
      <span class="rec-range">{e.rangeId}</span>
      <div class="rec-main">
        <span class="rec-when">{fmtDateTime(e.windowStart)}</span>
        <div class="rec-calls">
          called <span class={`rec-side ${sideCls}`}>{e.side}</span>{' '}
          {e.outcome == null ? (
            <span class="rec-arrow">→ pending</span>
          ) : (
            <>
              <span class="rec-arrow">→</span>
              <span class={`rec-side ${e.outcome === 'UP' ? 'up' : 'down'}`}>
                {e.outcome}
              </span>
            </>
          )}
          <span>
            {' '}
            · vs {fmtUsd2(e.strike)}
            {e.closePrice != null ? ` · closed ${fmtUsd2(e.closePrice)}` : ''}
          </span>
          {bet && (
            <span>
              {' '}
              · bet {fmtUsd2(bet.stake)} at {(bet.cost * 100).toFixed(1)}¢ →{' '}
              {bet.pnl === undefined ? (
                `to win ${fmtUsd2((bet.stake * (1 - bet.cost)) / bet.cost)}`
              ) : (
                <span class={`pt-pnl ${bet.pnl >= 0 ? 'up' : 'down'}`}>
                  {bet.pnl >= 0 ? '+' : ''}
                  {fmtUsd2(bet.pnl)}
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      <div class="rec-prob">
        {fmtPct(e.confidence)}
        <div class="rec-prob-sub">conf</div>
      </div>
    </div>
  );
}

export function RecordList() {
  const all = ledgerEntries.value;
  const filtered =
    recordFilter.value === 'ALL'
      ? all
      : all.filter(e => e.rangeId === recordFilter.value);
  return (
    <div class="card record-card">
      <div class="card-title record-list-title">
        <span>Call history</span>
      </div>
      {filtered.length > 0 ? (
        <VirtualList
          class="record-list"
          items={filtered}
          estimate={64}
          itemKey={e => e.id}
          renderItem={e => <RecordRow e={e} />}
        />
      ) : (
        <div class="record-empty" style={{ display: 'block' }}>
          {all.length ? 'No calls for this range yet.' : 'No resolved calls yet.'}
        </div>
      )}
    </div>
  );
}
