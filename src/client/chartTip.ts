// Recharts-style hover tooltip for the inline SVG charts: a vertical cursor
// snapped to the nearest data point plus a floating value readout.
//
// The charts are stateless strings re-rendered wholesale (innerHTML), so the
// overlay nodes are managed here as siblings of the chart markup and re-added
// if a render wiped them. attach() is idempotent: listeners bind once per
// container, each render simply swaps in fresh data, and an in-progress hover
// is re-painted from the new data so the tooltip survives live refreshes.

export interface TipRow {
  label: string;
  value: string;
  color?: string;
}

export interface TipData {
  title: string;
  rows: TipRow[];
}

export interface ChartTipOpts {
  /** X of each data point in viewBox units (0..100, left → right). */
  xs: number[];
  /** Tooltip payload for point i. */
  at: (i: number) => TipData;
}

interface State {
  opts: ChartTipOpts;
  cursor: HTMLElement;
  tip: HTMLElement;
  inside: boolean;
  /** Horizontal hover position as a fraction of the container width. */
  frac: number;
}

const states = new WeakMap<HTMLElement, State>();

function fracOf(el: HTMLElement, clientX: number): number {
  const r = el.getBoundingClientRect();
  return Math.min(1, Math.max(0, (clientX - r.left) / (r.width || 1)));
}

function hide(s: State): void {
  s.cursor.style.display = 'none';
  s.tip.style.display = 'none';
}

function paint(s: State): void {
  const { xs, at } = s.opts;
  if (!s.inside || xs.length === 0) {
    hide(s);
    return;
  }
  // Snap to the data point nearest the pointer.
  const targetX = s.frac * 100;
  let i = 0;
  let bestDist = Infinity;
  for (let j = 0; j < xs.length; j++) {
    const d = Math.abs(xs[j]! - targetX);
    if (d < bestDist) {
      bestDist = d;
      i = j;
    }
  }
  const x = xs[i]!;
  const d = at(i);

  s.cursor.style.display = 'block';
  s.cursor.style.left = `${x}%`;
  s.tip.style.display = 'block';
  s.tip.style.left = `${x}%`;
  // Flip to the left of the cursor near the right edge so it stays visible.
  s.tip.style.transform =
    x > 55 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)';
  s.tip.innerHTML =
    `<div class="chart-tip-title">${d.title}</div>` +
    d.rows
      .map(
        r =>
          `<div class="chart-tip-row">` +
          (r.color
            ? `<span class="chart-tip-swatch" style="background:${r.color}"></span>`
            : '') +
          `<span>${r.label}</span><span class="chart-tip-val">${r.value}</span></div>`
      )
      .join('');
}

/**
 * Enable (or refresh the data behind) the hover tooltip on a chart container.
 * Call after every chart render; cheap when already attached.
 */
export function attachChartTip(el: HTMLElement, opts: ChartTipOpts): void {
  let s = states.get(el);
  if (!s) {
    const cursor = document.createElement('div');
    cursor.className = 'chart-cursor';
    const tip = document.createElement('div');
    tip.className = 'chart-tip';
    s = { opts, cursor, tip, inside: false, frac: 0 };
    states.set(el, s);

    el.addEventListener('mousemove', e => {
      s!.inside = true;
      s!.frac = fracOf(el, e.clientX);
      paint(s!);
    });
    el.addEventListener('mouseleave', () => {
      s!.inside = false;
      hide(s!);
    });
    const touch = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      s!.inside = true;
      s!.frac = fracOf(el, t.clientX);
      paint(s!);
    };
    el.addEventListener('touchstart', touch, { passive: true });
    el.addEventListener('touchmove', touch, { passive: true });
    el.addEventListener('touchend', () => {
      s!.inside = false;
      hide(s!);
    });
  }
  s.opts = opts;
  // A render may have blown away the overlay nodes (innerHTML swap) — re-add.
  if (!s.cursor.isConnected) el.append(s.cursor, s.tip);
  // Keep an in-progress hover painted with the fresh data.
  if (s.inside) paint(s);
}
