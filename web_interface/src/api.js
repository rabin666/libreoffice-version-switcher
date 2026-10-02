// Thin client for the lovs HTTP API (api/server.js): JSON requests and the live job event stream.
// Every call carries the per-run session token; if the server restarted, the token is refreshed once.

const TOKEN_HEADER = 'X-Lovs-Token';
const RECONNECT_DELAY_MS = 2000;

let tokenPromise = null;

function getToken({ refresh = false } = {}) {
  if (refresh || !tokenPromise) {
    tokenPromise = fetch('/api/session')
      .then((response) => response.json())
      .then((session) => session.token)
      .catch((err) => {
        // Don't cache a failure: the next call should try again.
        tokenPromise = null;
        throw err;
      });
  }
  return tokenPromise;
}

async function sendRequest(path, { method, body }) {
  const hasBody = body !== undefined;
  const token = await getToken();
  return fetch(path, {
    method,
    headers: { [TOKEN_HEADER]: token, ...(hasBody ? { 'Content-Type': 'application/json' } : {}) },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

/** Calls a JSON endpoint and returns the parsed body; throws with the server's error message on failure. */
export async function api(path, { method = 'GET', body } = {}) {
  let response = await sendRequest(path, { method, body });
  if (response.status === 401) {
    // A restarted server issues a new token, so fetch it and retry once.
    await getToken({ refresh: true });
    response = await sendRequest(path, { method, body });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (HTTP ${response.status})`);
  return data;
}

/**
 * Live job updates over Server-Sent Events, reconnecting after errors.
 * Returns an unsubscribe function.
 */
export function subscribeJobs({ onSnapshot, onUpdate, onRemoved, onConnection }) {
  let eventSource = null;
  let unsubscribed = false;
  let reconnectTimer = null;

  const scheduleReconnect = () => {
    onConnection?.(false);
    if (!unsubscribed) reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  };

  async function connect() {
    try {
      // On a reconnect the server may have restarted, so don't trust the cached token.
      const token = await getToken({ refresh: eventSource !== null });
      if (unsubscribed) return;
      eventSource = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
      eventSource.addEventListener('open', () => onConnection?.(true));
      eventSource.addEventListener('jobs', (event) => onSnapshot(JSON.parse(event.data)));
      eventSource.addEventListener('job', (event) => onUpdate(JSON.parse(event.data)));
      eventSource.addEventListener('job-removed', (event) => onRemoved(JSON.parse(event.data).id));
      eventSource.addEventListener('error', () => {
        eventSource.close();
        scheduleReconnect();
      });
    } catch {
      scheduleReconnect();
    }
  }

  connect();
  return () => {
    unsubscribed = true;
    clearTimeout(reconnectTimer);
    eventSource?.close();
  };
}
