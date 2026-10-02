// Local web server: the JSON API under /api, server-sent job events, and
// the built React app (web_interface -> dist/ui) for everything else.
//
// The API can change PATH and run installers, so it is locked down:
//  - binds to 127.0.0.1 by default
//  - rejects foreign Host headers (DNS rebinding)
//  - every API call needs a per-run token; the page reads it from
//    /api/session, which other origins can't (no CORS headers)

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { APP_VERSION } from '../utils/appinfo.js';
import { isWindows } from '../utils/platform.js';
import { JobManager } from './jobs.js';
import { HttpError, matchRoute } from './router.js';
import { createRoutes } from './routes.js';

const MAX_BODY_BYTES = 1024 * 1024;
const PORT_ATTEMPTS = 10;
const SSE_PING_MS = 20_000;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** dist/ui next to the bundle (dist/lovs.cjs), or ../dist/ui when running from source. */
function findUiDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, 'ui'), path.join(here, '..', 'dist', 'ui')].find((dir) => fs.existsSync(path.join(dir, 'index.html'))) ?? null;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function decodeRequestPath(pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
  if (relative.includes('\0')) throw new HttpError(400, 'Malformed URL');
  return relative;
}

/** Serve a file from the UI build; unknown paths get index.html (client-side routing). */
function serveStatic(uiDir, pathname, res) {
  let relative = decodeRequestPath(pathname);
  if (!uiDir) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Web UI is not built. Run "npm run build:ui" (or use "npm run dev").');
    return;
  }
  let file = path.join(uiDir, relative);
  const inside = path.relative(uiDir, file);
  const escapesUiDir = inside.startsWith('..') || path.isAbsolute(inside);
  if (escapesUiDir || !relative || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    relative = 'index.html';
    file = path.join(uiDir, relative);
  }
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    // Vite fingerprints everything under assets/, so those can be cached forever.
    'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(fs.readFileSync(file));
}

function openBrowser(url) {
  const [command, args] = isWindows ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/** Listen on `port`, or the next free port up to PORT_ATTEMPTS later; returns the actual port. */
async function listenOnFreePort(server, port, host) {
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, port + attempt, host);
      return server.address().port; // resolves port 0 too
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= PORT_ATTEMPTS) throw err;
    }
  }
}

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/** This machine's own names and addresses, as they appear in a Host header. */
function ownHostNames() {
  const names = [os.hostname().toLowerCase()];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const { address, family } of addresses ?? []) names.push(family === 'IPv6' || family === 6 ? `[${address.toLowerCase()}]` : address);
  }
  return names;
}

/**
 * Host headers we answer. Always loopback; plus the bind address, or — when
 * bound to all interfaces — this machine's own addresses and hostname. Any
 * other name (e.g. a DNS-rebinding domain pointing at us) is refused, so the
 * session token never reaches a foreign origin.
 */
function allowedHosts(host, port) {
  const names = ['127.0.0.1', 'localhost', '[::1]'];
  if (WILDCARD_HOSTS.has(host)) names.push(...ownHostNames());
  else if (!names.includes(host)) names.push(host.toLowerCase());
  return new Set(names.map((name) => `${name}:${port}`));
}

/** Start the server; resolves with {server, port, url}. */
export async function startServer({ port = 5178, host = '127.0.0.1', open = true } = {}) {
  const sessionToken = crypto.randomBytes(24).toString('hex');
  const jobs = new JobManager();
  const routes = createRoutes({ jobs, appVersion: APP_VERSION });
  const uiDir = findUiDir();
  const eventClients = new Set();
  let actualPort = port;

  const broadcast = (event, data) => {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of eventClients) res.write(message);
  };
  jobs.on('update', (job) => broadcast('job', job));
  jobs.on('removed', (id) => broadcast('job-removed', { id }));

  const streamEvents = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`event: jobs\ndata: ${JSON.stringify(jobs.list())}\n\n`);
    eventClients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
    const forget = () => {
      clearInterval(ping);
      eventClients.delete(res);
    };
    res.on('close', forget);
    res.on('error', forget);
  };

  const handleApi = async (req, res, url) => {
    const { pathname } = url;
    try {
      if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, { token: sessionToken });
      const token = req.headers['x-lovs-token'] ?? url.searchParams.get('token'); // EventSource can't send headers
      if (token !== sessionToken) throw new HttpError(401, 'Missing or invalid session token');
      if (pathname === '/api/events' && req.method === 'GET') return streamEvents(res);

      const route = matchRoute(routes, req.method, pathname);
      if (!route) throw new HttpError(404, `No route for ${req.method} ${pathname}`);
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readJsonBody(req) : null;
      const data = await route.handler({ params: route.params, query: Object.fromEntries(url.searchParams), body });
      sendJson(res, 200, data ?? { ok: true });
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(pc.red(`[api] ${req.method} ${pathname}: ${err.stack ?? err}`));
      sendJson(res, status, { error: err.message ?? String(err) });
    }
  };

  const handleRequest = async (req, res) => {
    if (!allowedHosts(host, actualPort).has(String(req.headers.host ?? '').toLowerCase())) {
      res.writeHead(403).end('Forbidden host');
      return;
    }
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      throw new HttpError(400, 'Malformed URL');
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    serveStatic(uiDir, url.pathname, res);
  };

  // One error boundary for every request: a bad request must never stop the server.
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      const status = err.status ?? 500;
      if (status === 500) console.error(pc.red(`[http] ${req.method} ${req.url}: ${err.stack ?? err}`));
      if (res.headersSent) return void res.destroy();
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(status === 500 ? 'Internal server error' : err.message);
    });
  });

  actualPort = await listenOnFreePort(server, port, host);
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${shownHost}:${actualPort}/`;
  console.log(`${pc.green('✔')} lovs web UI running at ${pc.bold(url)}`);
  if (!uiDir) console.log(pc.yellow('  (UI not built: API only. Run "npm run build:ui" or "npm run dev".)'));
  console.log(pc.dim('  Press Ctrl+C to stop.'));
  if (open) openBrowser(url);
  return { server, port: actualPort, url };
}
