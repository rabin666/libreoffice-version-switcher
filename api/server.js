// Local web server for the UI: JSON API under /api, the built React app
// (web_interface -> dist/ui) for everything else.
//
// The API can change PATH and run installers, so it is locked down:
//  - binds to 127.0.0.1 by default
//  - rejects requests whose Host header isn't localhost (DNS rebinding)
//  - every API call needs a per-run token. The page gets it from
//    /api/session; other websites can't read that response (no CORS).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import { APP_VERSION } from '../utils/appinfo.js';
import { isWindows } from '../utils/platform.js';
import { JobManager } from './jobs.js';
import { HttpError, createRoutes, matchRoute } from './routes.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function findUiDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // bundled: dist/lovs.cjs -> dist/ui ; from source: api/ -> ../dist/ui
  const candidates = [path.join(here, 'ui'), path.join(here, '..', 'dist', 'ui')];
  return candidates.find((d) => fs.existsSync(path.join(d, 'index.html'))) ?? null;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function serveStatic(uiDir, pathname, res) {
  if (!uiDir) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Web UI is not built. Run "npm run build:ui" (or use "npm run dev").');
    return;
  }
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  let file = path.join(uiDir, rel);
  if (!file.startsWith(uiDir) || !rel || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    rel = 'index.html'; // SPA fallback
    file = path.join(uiDir, rel);
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Cache-Control': rel.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(fs.readFileSync(file));
}

function openBrowser(url) {
  const [cmd, args] = isWindows ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
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

export async function startServer({ port = 5178, host = '127.0.0.1', open = true } = {}) {
  const token = crypto.randomBytes(24).toString('hex');
  const jobs = new JobManager();
  const routes = createRoutes({ jobs, appVersion: APP_VERSION });
  const uiDir = findUiDir();
  const sseClients = new Set();
  let actualPort = port;

  const broadcast = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) res.write(msg);
  };
  jobs.on('update', (job) => broadcast('job', job));
  jobs.on('removed', (id) => broadcast('job-removed', { id }));

  const server = http.createServer(async (req, res) => {
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    const okHosts = [`127.0.0.1:${actualPort}`, `localhost:${actualPort}`, `[::1]:${actualPort}`];
    if (host !== '127.0.0.1' && host !== 'localhost') okHosts.push(`${host}:${actualPort}`);
    if (!okHosts.includes(hostHeader)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
      return serveStatic(uiDir, pathname, res);
    }

    try {
      if (pathname === '/api/session' && req.method === 'GET') return sendJson(res, 200, { token });

      const given = req.headers['x-lovs-token'] ?? url.searchParams.get('token');
      if (given !== token) throw new HttpError(401, 'Missing or invalid session token');

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write(`event: jobs\ndata: ${JSON.stringify(jobs.list())}\n\n`);
        sseClients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }

      const match = matchRoute(routes, req.method, pathname);
      if (!match) throw new HttpError(404, `No route for ${req.method} ${pathname}`);
      const body = ['POST', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : null;
      const data = await match.handler({ params: match.params, query: Object.fromEntries(url.searchParams), body });
      sendJson(res, 200, data ?? { ok: true });
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(pc.red(`[api] ${req.method} ${pathname}: ${err.stack ?? err}`));
      sendJson(res, status, { error: err.message ?? String(err) });
    }
  });

  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, actualPort, host);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt >= 10) throw err;
      actualPort++;
    }
  }

  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const url = `http://${shownHost}:${actualPort}/`;
  console.log(`${pc.green('✔')} lovs web UI running at ${pc.bold(url)}`);
  if (!uiDir) console.log(pc.yellow('  (UI not built: API only. Run "npm run build:ui" or "npm run dev".)'));
  console.log(pc.dim('  Press Ctrl+C to stop.'));
  if (open) openBrowser(url);
  return { server, port: actualPort, url };
}
