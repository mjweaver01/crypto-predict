// Window-boundary helpers shared by the live prediction path and the backfill
// script, so a backfilled window is defined identically to the one the live
// model would have produced (same noon-ET daily boundaries, no drift between
// the two code paths).

const ET = 'America/New_York';

/** ET wall-clock offset (local - UTC) in ms at a given instant. */
export function etOffsetMs(utcMs: number): number {
  const d = new Date(utcMs);
  const loc = new Date(d.toLocaleString('en-US', { timeZone: ET }));
  const utc = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  return loc.getTime() - utc.getTime();
}

/** UTC instant for 12:00 ET on the ET calendar date containing `refMs`. */
export function noonEtUtc(refMs: number): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: ET,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(refMs))
    .split('-')
    .map(Number);
  const wallAsUtc = Date.UTC(y!, m! - 1, d!, 12, 0, 0);
  return wallAsUtc - etOffsetMs(wallAsUtc);
}

/**
 * The active daily window (noon ET → next noon ET) for an instant. Mirrors the
 * live logic in routes/predict.ts: the active daily market is the one whose
 * closing noon is still ahead of `now`.
 */
export function dailyWindowAt(now: number): { start: number; end: number } {
  const todayNoon = noonEtUtc(now);
  const end =
    now >= todayNoon ? noonEtUtc(todayNoon + 30 * 3_600_000) : todayNoon;
  const start =
    now >= todayNoon ? todayNoon : noonEtUtc(todayNoon - 18 * 3_600_000);
  return { start, end };
}
