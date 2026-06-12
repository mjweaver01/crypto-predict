// A window-close countdown that ticks off the shared `now` signal (no per-node
// timers, no DOM scanning). Goes "closing" inside the last minute.

import { now } from './state.ts';

/** Compact remaining-time label: 4:32 under an hour, 3h 12m under a day. */
export function fmtCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  if (s < 3600)
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    return `${h}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
  }
  const d = Math.floor(s / 86_400);
  return `${d}d ${Math.floor((s % 86_400) / 3600)}h`;
}

export function Countdown({
  end,
  class: cls,
}: {
  end: string;
  class?: string;
}) {
  const left = Date.parse(end) - now.value;
  const closing = left <= 60_000 && left > 0;
  return (
    <span class={`${cls ?? ''}${closing ? ' closing' : ''}`}>
      {fmtCountdown(left)}
    </span>
  );
}
