// The big spot-price chart. Its eased, time-advancing right edge is inherently a
// 60fps imperative animation, so it runs its own requestAnimationFrame loop that
// writes directly into refs — deliberately off Preact's render path. The loop
// reads signals with plain `.value` (no subscription outside a component), so
// the animation never triggers VDOM work.

import { useEffect, useRef } from 'preact/hooks';
import type { PricePoint } from '../../shared/types.ts';
import { CRYPTOS } from '../../shared/cryptos.ts';
import {
  COLORS,
  fmtClock,
  fmtDateTime,
  fmtDay,
  fmtUsd,
  fmtUsd2,
  px,
} from '../format.ts';
import { heroRender } from '../charts.ts';
import { attachChartTip } from '../chartTip.ts';
import { selectedCrypto } from '../crypto.ts';
import { heroEdge, latest, liveTicks, selectedSpot } from './state.ts';

const EASE = 0.08; // per-frame approach toward the latest tick (~1s settle)

function focusMeta() {
  const c = selectedCrypto.value;
  return CRYPTOS[c === 'all' ? 'btc' : c];
}

/** The series for the active range, with the eased live edge grafted on. */
function heroSeries(): PricePoint[] {
  const edge = heroEdge.display ?? heroEdge.last;
  const t = Date.now();
  if (selectedSpot.value === 'LIVE') {
    if (liveTicks.length === 0) return [];
    return edge !== null ? [...liveTicks, { t, price: edge }] : liveTicks;
  }
  const base =
    latest.value?.spot?.[selectedSpot.value] ?? latest.value?.history ?? [];
  if (edge !== null && base.length) return [...base, { t, price: edge }];
  return base;
}

export function HeroChart() {
  const hostRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<HTMLDivElement>(null);
  const dotRef = useRef<HTMLSpanElement>(null);
  const axisRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      if (heroEdge.last !== null) {
        heroEdge.display =
          heroEdge.display === null
            ? heroEdge.last
            : heroEdge.display + (heroEdge.last - heroEdge.display) * EASE;
      }
      const pts = heroSeries();
      const { svg, dot } = heroRender(pts);
      if (svgRef.current) svgRef.current.innerHTML = svg;

      const dotEl = dotRef.current;
      if (dotEl) {
        if (dot) {
          dotEl.style.display = '';
          dotEl.style.left = `${px(dot.x)}%`;
          dotEl.style.top = `${px(dot.y)}%`;
          dotEl.style.background = dot.color;
          dotEl.style.color = dot.color;
        } else {
          dotEl.style.display = 'none';
        }
      }

      if (hostRef.current && pts.length >= 2) {
        const t0 = pts[0]!.t;
        const span = pts[pts.length - 1]!.t - t0 || 1;
        const longSpan = span > 24 * 3_600_000;
        attachChartTip(hostRef.current, {
          xs: pts.map(p => ((p.t - t0) / span) * 100),
          at: i => {
            const p = pts[i]!;
            return {
              title: longSpan
                ? fmtDateTime(new Date(p.t).toISOString())
                : new Date(p.t).toLocaleTimeString(),
              rows: [
                {
                  label: `${focusMeta().ticker}/USDT`,
                  value: fmtUsd2(p.price),
                  color: COLORS.accent,
                },
              ],
            };
          },
        });
      }

      if (axisRef.current) {
        if (pts.length >= 2) {
          const prices = pts.map(h => h.price);
          const hi = Math.max(...prices);
          const lo = Math.min(...prices);
          const span = pts[pts.length - 1]!.t - pts[0]!.t;
          const startLabel =
            span > 24 * 3_600_000
              ? fmtDay(pts[0]!.t)
              : fmtClock(new Date(pts[0]!.t).toISOString());
          axisRef.current.innerHTML =
            `<span>${startLabel}</span>` +
            `<span class="hl">H <b>${fmtUsd(hi)}</b> · L <b>${fmtUsd(lo)}</b></span>` +
            `<span>now</span>`;
        } else {
          axisRef.current.innerHTML = '';
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <div class="chart hero" ref={hostRef}>
        <div ref={svgRef}>
          <div class="chart-empty"></div>
        </div>
        <span class="live-dot" ref={dotRef} style={{ display: 'none' }}></span>
      </div>
      <div class="hero-axis" ref={axisRef}></div>
    </>
  );
}
