// Renders a pre-built SVG chart string and (re)attaches the hover tooltip after
// every render. attachChartTip is idempotent and re-adds its overlay nodes when
// a render swaps the innerHTML, so this stays correct as the data updates.

import { useEffect, useRef } from 'preact/hooks';
import { attachChartTip, type ChartTipOpts } from '../chartTip.ts';

interface Props {
  svg: string;
  class?: string;
  tip?: ChartTipOpts;
}

export function Chart({ svg, class: cls, tip }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && tip) attachChartTip(ref.current, tip);
  });
  return (
    <div ref={ref} class={cls} dangerouslySetInnerHTML={{ __html: svg }} />
  );
}
