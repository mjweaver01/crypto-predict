// "Model read": the stats-grounded headline + the longer description paragraph,
// clamped behind a "read more" toggle when it overflows. Hidden in the All view.

import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  buildDescription,
  buildNarrative,
  toRangeDetail,
} from '../../shared/narrative.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import { latest, selectedTab } from './state.ts';

export function NarrativeCard() {
  const p = latest.value;
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const reasoningRef = useRef<HTMLParagraphElement>(null);

  const range =
    (p && p.ranges.find(r => r.id === selectedTab.value)) ?? p?.ranges[0];

  let headline = p?.narrative ?? 'Loading…';
  let description = '';
  if (p && range) {
    const ctx = {
      asset: `${CRYPTOS[p.crypto].ticker}/USDT`,
      price: p.stats.price,
    };
    headline = buildNarrative(p.stats, {
      ...ctx,
      reads: [
        {
          label: range.label,
          horizonMin: range.horizonMinutes,
          strike: range.strike,
          probUp: range.probUp,
          marketImpliedUp: range.market?.impliedUp,
        },
      ],
    });
    description = buildDescription(p.stats, {
      ...ctx,
      range: toRangeDetail(range),
    });
  }

  // Collapse back to clamped whenever the description text changes.
  const lastText = useRef(description);
  if (lastText.current !== description) {
    lastText.current = description;
    if (expanded) setExpanded(false);
  }

  // Measure overflow after layout to decide whether the toggle is needed.
  useLayoutEffect(() => {
    const el = reasoningRef.current;
    if (!el) return;
    setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [description, expanded]);

  return (
    <div class="card narrative-card">
      <div class="narrative-head">
        <span class="card-title">
          <span>Model read</span>
        </span>
      </div>
      <p id="narrative">{headline}</p>
      <p
        id="reasoning"
        ref={reasoningRef}
        class={`${!expanded ? 'clamped' : ''} ${!expanded && overflows ? 'truncated' : ''}`}
      >
        {description}
      </p>
      <button
        class="read-more"
        style={{
          display: description && (expanded || overflows) ? '' : 'none',
        }}
        onClick={() => setExpanded(v => !v)}
      >
        {expanded ? 'Show less' : 'Read more'}
      </button>
    </div>
  );
}
