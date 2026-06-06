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

export const COLORS = {
  up: '#34d399',
  down: '#f87171',
  accent: '#f7931a',
  muted: '#7b8fa8',
};
