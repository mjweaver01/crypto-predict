// Windowed (virtualized) list for long, variably-sized rows. Only the rows in
// (or near) the viewport are mounted; the rest is reserved as empty space so
// the scrollbar still reflects the full list. Row heights are measured after
// layout and cached per key, so wrapped narratives/calls size correctly without
// us hard-coding a height. Replaces pagination on the history scroll cards.

import type { ComponentChildren } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

interface VirtualListProps<T> {
  items: T[];
  /** Best-guess row height (px) for not-yet-measured rows. */
  estimate: number;
  /** Stable key per item — keeps measured heights across re-renders. */
  itemKey: (item: T, index: number) => string | number;
  renderItem: (item: T, index: number) => ComponentChildren;
  /** Class for the scroll container (keeps the existing card CSS). */
  class?: string;
  /** Extra rows rendered above/below the viewport. */
  overscan?: number;
}

export function VirtualList<T>({
  items,
  estimate,
  itemKey,
  renderItem,
  class: cls,
  overscan = 6,
}: VirtualListProps<T>) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const heights = useRef<Map<string | number, number>>(new Map());
  const rowEls = useRef<Map<string | number, HTMLDivElement>>(new Map());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  // Bumped whenever a measured height changes, to recompute offsets.
  const [, setTick] = useState(0);

  // Cumulative offsets from measured-or-estimated heights.
  const offsets: number[] = new Array(items.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < items.length; i++) {
    const h = heights.current.get(itemKey(items[i]!, i)) ?? estimate;
    offsets[i + 1] = offsets[i]! + h;
  }
  const total = offsets[items.length]!;

  const pad = overscan * estimate;
  const top = scrollTop - pad;
  const bottom = scrollTop + viewport + pad;

  // First/last visible index (linear scan is fine for a few thousand rows).
  let start = 0;
  while (start < items.length && offsets[start + 1]! < top) start++;
  let end = start;
  while (end < items.length && offsets[end]! < bottom) end++;

  // Measure rendered rows after layout; recompute if any height changed.
  useLayoutEffect(() => {
    let changed = false;
    for (const [key, el] of rowEls.current) {
      const h = el.offsetHeight;
      if (h > 0 && heights.current.get(key) !== h) {
        heights.current.set(key, h);
        changed = true;
      }
    }
    if (changed) setTick(t => t + 1);
  });

  const onScroll = (e: Event) => {
    const el = e.currentTarget as HTMLDivElement;
    setScrollTop(el.scrollTop);
    if (el.clientHeight !== viewport) setViewport(el.clientHeight);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight !== viewport) setViewport(el.clientHeight);
  });

  const visible = [];
  rowEls.current = new Map();
  for (let i = start; i < end; i++) {
    const item = items[i]!;
    const key = itemKey(item, i);
    visible.push(
      <div
        key={key}
        ref={el => {
          if (el) rowEls.current.set(key, el);
        }}
        style={{ position: 'absolute', top: offsets[i]!, left: 0, right: 0 }}
      >
        {renderItem(item, i)}
      </div>
    );
  }

  return (
    <div ref={scrollRef} class={cls} onScroll={onScroll}>
      <div style={{ position: 'relative', height: total, flex: '0 0 auto' }}>
        {visible}
      </div>
    </div>
  );
}
