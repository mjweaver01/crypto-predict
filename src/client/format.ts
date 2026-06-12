// Shared client-side helpers: DOM lookup, formatters, and palette used by both
// the live dashboard and the history view.

export const $ = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;

export const fmtUsd = (n: number) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  });

export const fmtUsd2 = (n: number) =>
  n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  });

export const fmtPct = (p: number) => `${(p * 100).toFixed(1)}%`;

/** Price formatter that adapts to sub-dollar assets (XRP/DOGE). */
export const fmtPx = (n: number) =>
  n >= 1000 ? fmtUsd(n) : n >= 1 ? fmtUsd2(n) : `$${n.toFixed(4)}`;

export const fmtClock = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export const fmtDay = (t: number) =>
  new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });

export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

export function relTime(targetIso: string): string {
  const mins = Math.round(
    (new Date(targetIso).getTime() - Date.now()) / 60_000
  );
  if (mins < 1) return 'now';
  if (mins < 60) return `in ${mins}m`;
  if (mins < 60 * 24) return `in ${(mins / 60).toFixed(1)}h`;
  return `in ${(mins / (60 * 24)).toFixed(1)}d`;
}

export const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    c =>
      (
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        }) as Record<string, string>
      )[c]!
  );

export const px = (n: number) => n.toFixed(2);

// ── Persisted UI preferences (selected tab, spot range, filters) ──────────

/** Read a saved preference, falling back unless it's one of `allowed`. */
export function loadPref<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  try {
    const v = localStorage.getItem(`bp.${key}`);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback; // storage blocked (private mode etc.)
  }
}

export function savePref(key: string, value: string): void {
  try {
    localStorage.setItem(`bp.${key}`, value);
  } catch {
    // best-effort; losing a preference is fine
  }
}

export const COLORS = {
  up: '#34d399',
  down: '#f87171',
  accent: '#f7931a',
  muted: '#7b8fa8',
};
