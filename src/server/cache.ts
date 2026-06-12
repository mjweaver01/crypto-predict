// Tiny in-memory TTL cache with a get-or-fetch helper.

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

// Single-flight: misses on a key that is already being fetched join the
// in-flight promise instead of starting another fetch. Without this, a fetcher
// slower than the callers' cadence (e.g. a long LLM generation vs the 20s
// commit tick) stampedes the upstream with duplicate concurrent requests.
const inflight = new Map<string, Promise<unknown>>();

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  const pending = inflight.get(key) as Promise<T> | undefined;
  // A refresh is already running. If we have a (stale) value, serve it now
  // rather than waiting on the recompute — keeps requests responsive.
  if (pending) return hit ? hit.value : pending;

  const run = (async () => {
    try {
      const value = await fetcher();
      store.set(key, { value, expires: Date.now() + ttlSeconds * 1000 });
      return value;
    } catch (err) {
      // Degrade gracefully: serve stale data if we have any.
      if (hit) {
        console.warn(`[cache] fetch failed for "${key}", serving stale`, err);
        return hit.value;
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);

  // Stale-while-revalidate: when the entry has merely expired (we still hold a
  // value), serve the stale value immediately and let the recompute replace the
  // cache in the background. The first caller after a window resolves no longer
  // blocks on the full recalculation. Only a cold miss (no value yet) waits.
  if (hit) {
    run.catch(() => {}); // background refresh; errors already fall back to stale
    return hit.value;
  }
  return run;
}

/** Drop a cached entry so the next `cached()` call recomputes it. */
export function invalidate(key: string): void {
  store.delete(key);
}

export function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}
