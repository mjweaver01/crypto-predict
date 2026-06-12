// The "over time" window selector (24h / 7d / 30d / 90d / All time) — distinct
// from the per-family bet filter. Lives in the header; changing it re-fetches
// the ledger, metrics, and paper scoreboard for the new window.

import { DATE_PRESETS, DATE_PRESET_LABELS, datePreset } from './state.ts';

export function DateRangeBar() {
  return (
    <div class="date-range-bar">
      {DATE_PRESETS.map(p => (
        <button
          key={p}
          class={p === datePreset.value ? 'active' : ''}
          onClick={() => {
            datePreset.value = p;
          }}
        >
          {DATE_PRESET_LABELS[p]}
        </button>
      ))}
    </div>
  );
}
