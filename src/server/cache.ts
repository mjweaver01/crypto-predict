// Tiny in-memory TTL cache with a get-or-fetch helper.

interface Entry<T> {
  value: T;
  expires: number;
}

const store = new Map<string, Entry<unknown>>();

export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const now = Date.now();
  const hit = store.get(key) as Entry<T> | undefined;
  if (hit && hit.expires > now) return hit.value;

  try {
    const value = await fetcher();
    store.set(key, { value, expires: now + ttlSeconds * 1000 });
    return value;
  } catch (err) {
    // Degrade gracefully: serve stale data if we have any.
    if (hit) {
      console.warn(`[cache] fetch failed for "${key}", serving stale`, err);
      return hit.value;
    }
    throw err;
  }
}

export function env(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}
