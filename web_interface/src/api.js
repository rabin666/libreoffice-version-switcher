// Thin client for the lovs API (api/server.js). Every call carries the
// per-run session token; if the server restarted, the token is refreshed once.

let tokenPromise = null;

function getToken(force = false) {
  if (force || !tokenPromise) {
    tokenPromise = fetch('/api/session')
      .then((r) => r.json())
      .then((d) => d.token)
      .catch((err) => {
        tokenPromise = null;
        throw err;
      });
  }
  return tokenPromise;
}

export async function api(path, { method = 'GET', body } = {}, retried = false) {
  const token = await getToken();
  const res = await fetch(path, {
    method,
    headers: { 'X-Lovs-Token': token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && !retried) {
    await getToken(true);
    return api(path, { method, body }, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
}

/** Live job updates over Server-Sent Events. Returns an unsubscribe function. */
export function subscribeJobs({ onSnapshot, onUpdate, onRemoved, onConnection }) {
  let es = null;
  let closed = false;
  let retry = null;

  const connect = async () => {
    try {
      const token = await getToken(es !== null);
      if (closed) return;
      es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      es.addEventListener('open', () => onConnection?.(true));
      es.addEventListener('jobs', (e) => onSnapshot(JSON.parse(e.data)));
      es.addEventListener('job', (e) => onUpdate(JSON.parse(e.data)));
      es.addEventListener('job-removed', (e) => onRemoved(JSON.parse(e.data).id));
      es.addEventListener('error', () => {
        onConnection?.(false);
        es.close();
        if (!closed) retry = setTimeout(connect, 2000);
      });
    } catch {
      onConnection?.(false);
      if (!closed) retry = setTimeout(connect, 2000);
    }
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}

export function formatBytes(n) {
  if (n == null || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '–';
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${String(Math.round(sec % 60)).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http://127.0.0.1 is a secure context, but fall back just in case
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
