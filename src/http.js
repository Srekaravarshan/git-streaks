/** Sleep helper. */
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * GET JSON with retry + backoff. Honours `Retry-After` on 429 and retries
 * transient 5xx. Throws on persistent non-2xx (caller decides whether to skip).
 * @param {string} url
 * @param {object} opts
 * @param {Record<string,string>} opts.headers
 * @param {number} [opts.retries=5]
 * @returns {Promise<any>} parsed JSON body
 */
export async function getJson(url, { headers = {}, retries = 5 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let res;
    try {
      res = await fetch(url, { headers });
    } catch (err) {
      // Network blip — back off and retry.
      if (attempt++ >= retries) throw err;
      await sleep(backoff(attempt));
      continue;
    }

    if (res.ok) return res.json();

    if (res.status === 429 || res.status >= 500) {
      if (attempt++ >= retries) {
        throw new Error(`HTTP ${res.status} after ${retries} retries: ${url}`);
      }
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }

    // 4xx (auth, not found, etc.) — not retryable.
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${url}\n${body.slice(0, 300)}`);
  }
}

/** Exponential backoff with jitter, capped at 30s. */
function backoff(attempt) {
  return Math.min(30000, 2 ** attempt * 500) + Math.floor(Math.random() * 400);
}

/**
 * Run an async mapper over items with bounded concurrency, preserving order.
 * @template T,R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item:T, index:number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
