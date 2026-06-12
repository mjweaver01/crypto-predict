// Windowed in-memory log of how the model's read evolved (the insights feed).

import type { InsightSnapshot } from '../../shared/types.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import { fmtPct, fmtUsd } from '../format.ts';
import { VirtualList } from '../components/VirtualList.tsx';
import { insights } from './state.ts';

function ReadRow({ e }: { e: InsightSnapshot }) {
  const ticker = CRYPTOS[e.crypto ?? 'btc']?.ticker ?? 'BTC';
  const change = `${e.change24hPct >= 0 ? '+' : ''}${e.change24hPct.toFixed(2)}%`;
  return (
    <div class="hist">
      <div class="hist-top">
        <span class="hist-time">{new Date(e.asOf).toLocaleTimeString()}</span>
        <span class="hist-method stats">{ticker}</span>
        <span>
          {fmtUsd(e.price)} · {change} 24h
        </span>
      </div>
      <div class="hist-narrative">{e.narrative}</div>
      <div class="hist-calls">
        {e.calls.map(c => (
          <span
            class={`hist-call ${c.side === 'UP' ? 'up' : 'down'}`}
            key={c.id}
          >
            {c.label} {c.side} {fmtPct(c.probUp)}
          </span>
        ))}
      </div>
    </div>
  );
}

export function PreviousReads() {
  const entries = insights.value;
  return (
    <div class="card history-card">
      <div class="history-head">
        <span class="card-title">
          <span>Previous reads</span>
        </span>
      </div>
      {entries.length > 0 ? (
        <VirtualList
          class="history-list"
          items={entries}
          estimate={120}
          itemKey={e => `${e.asOf}-${e.crypto ?? 'btc'}`}
          renderItem={e => <ReadRow e={e} />}
        />
      ) : (
        <div class="history-empty" style={{ display: 'block' }}>
          No history yet.
        </div>
      )}
    </div>
  );
}
