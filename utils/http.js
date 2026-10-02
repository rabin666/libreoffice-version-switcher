// fetch() wrappers with timeouts and retries for the archive server.

import { sleep } from './fsutil.js';

const USER_AGENT = 'libreoffice-version-switcher (+https://github.com/rabin666/libreoffice-version-switcher)';
const RETRIES = 3;

/** fetch() that times out after `timeout` ms and also honours an outer AbortSignal. */
export async function fetchWithTimeout(url, { timeout = 30000, signal, headers, ...options } = {}) {
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  return fetch(url, {
    ...options,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.any(signals),
    redirect: 'follow',
  });
}

/** Response body as text. Retries transient failures; a 404 throws at once with `status: 404`. */
export async function fetchText(url, options = {}) {
  let lastError;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);
      if (response.status === 404) throw Object.assign(new Error(`Not found: ${url}`), { status: 404 });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await response.text();
    } catch (err) {
      lastError = err;
      if (err.status === 404 || options.signal?.aborted) throw err;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastError;
}
