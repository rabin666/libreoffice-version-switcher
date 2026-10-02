const USER_AGENT = 'libreoffice-version-switcher (+https://github.com/rabin666/libreoffice-version-switcher)';

export const defaultHeaders = { 'User-Agent': USER_AGENT };

/** fetch() with a timeout that also honours an outer AbortSignal. */
export async function fetchWithTimeout(url, { timeout = 30000, signal, headers, ...opts } = {}) {
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  return fetch(url, {
    ...opts,
    headers: { ...defaultHeaders, ...headers },
    signal: AbortSignal.any(signals),
    redirect: 'follow',
  });
}

export async function fetchText(url, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchWithTimeout(url, opts);
      if (res.status === 404) {
        const err = new Error(`Not found: ${url}`);
        err.status = 404;
        throw err;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (err.status === 404 || opts.signal?.aborted) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr;
}
