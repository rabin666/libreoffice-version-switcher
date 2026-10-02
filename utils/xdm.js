// Hand downloads to Xtreme Download Manager (XDM 7.x).
//
// XDM ignores "-u <url>" when it is the first instance, so we start it in the
// background if needed and then talk to its local control port, the same way
// a second "xdman -u ..." invocation would (GET /cmd with "key:value" lines).
// XDM gives no completion callback, so we watch the output folder instead.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { isWindows } from './platform.js';

export const XDM_PORT = 9614;

function defaultCandidates() {
  if (isWindows) {
    return [
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'XDM'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'XDM'),
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'XDM'),
    ].filter(Boolean);
  }
  return ['/opt/xdman', '/usr/lib/xdman', '/usr/bin/xdman'];
}

function javaFor(dir) {
  const bin = isWindows ? 'javaw.exe' : 'java';
  for (const rt of ['java-runtime', 'jre']) {
    const p = path.join(dir, rt, 'bin', bin);
    if (fs.existsSync(p)) return p;
  }
  return isWindows ? 'javaw' : 'java';
}

function launcherFor(candidate) {
  let stat;
  try {
    stat = fs.statSync(candidate);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    const jar = path.join(candidate, 'xdman.jar');
    if (fs.existsSync(jar)) return { command: javaFor(candidate), args: ['-jar', jar], path: candidate };
    for (const exe of isWindows ? ['xdm-app.exe', 'xdman.exe'] : ['xdman', 'xdm-app']) {
      const p = path.join(candidate, exe);
      if (fs.existsSync(p)) return { command: p, args: [], path: p };
    }
    return null;
  }
  if (candidate.toLowerCase().endsWith('.jar')) {
    return { command: javaFor(path.dirname(candidate)), args: ['-jar', candidate], path: candidate };
  }
  return { command: candidate, args: [], path: candidate };
}

/** Locate XDM from the configured path, or from common install folders. */
export function findXdm(xdmPath) {
  const candidates = xdmPath ? [xdmPath] : defaultCandidates();
  for (const c of candidates) {
    const launcher = launcherFor(c);
    if (launcher) return launcher;
  }
  return null;
}

export function isXdmRunning() {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: XDM_PORT });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(1000, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

/** Status for the UI / CLI: where XDM is and whether it is running. */
export async function xdmStatus(xdmPath) {
  const launcher = findXdm(xdmPath);
  return { found: Boolean(launcher), path: launcher?.path ?? null, running: await isXdmRunning() };
}

function sendXdmCommand(lines) {
  const body = Buffer.from(lines.map((l) => `${l}\n`).join(''), 'utf8');
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: XDM_PORT, path: '/cmd', method: 'GET', headers: { 'Content-Length': body.length } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.setTimeout(10000, () => req.destroy(new Error('XDM did not respond')));
    req.once('error', reject);
    req.end(body);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureXdmRunning(xdmPath, onLog) {
  if (await isXdmRunning()) return;
  const launcher = findXdm(xdmPath);
  if (!launcher) {
    throw new Error('XDM is not running and was not found. Set its location with: lovs config set xdmPath <path>');
  }
  onLog?.(`Starting XDM (${launcher.path})`);
  const child = spawn(launcher.command, [...launcher.args, '-m'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 60; i++) {
    await wait(500);
    if (await isXdmRunning()) return;
  }
  throw new Error('XDM did not start within 30 seconds');
}

function cancelledError() {
  const err = new Error('Cancelled. XDM may still be downloading; stop it from the XDM window.');
  err.name = 'AbortError';
  return err;
}

/**
 * Ask XDM to download `url` into `destDir` and resolve with the downloaded
 * file path once a file of `expectedSize` bytes has appeared and stopped growing.
 */
export async function downloadWithXdm({ url, destDir, fileName, expectedSize, xdmPath, signal, onProgress, onLog }) {
  await ensureXdmRunning(xdmPath, onLog);
  // A fresh folder per download: whatever file appears in it is ours, even if
  // XDM decides to rename it.
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });

  const status = await sendXdmCommand([`url:${url}`, `output:${path.join(destDir, fileName)}`, 'quiet:true']);
  if (status !== 200) throw new Error(`XDM rejected the download request (HTTP ${status})`);
  onLog?.('Download handed to XDM; waiting for it to finish');
  // "quiet" is a persistent XDM setting; switch it back off once XDM has
  // picked up our request so browser downloads still show XDM's dialog.
  setTimeout(() => sendXdmCommand(['quiet:false']).catch(() => {}), 5000);

  let lastSize = -1;
  let stableTicks = 0;
  for (;;) {
    if (signal?.aborted) throw cancelledError();
    await wait(1000);
    let best = null;
    try {
      for (const name of await fsp.readdir(destDir)) {
        const st = await fsp.stat(path.join(destDir, name));
        if (st.isFile() && (!best || st.size > best.size)) best = { file: path.join(destDir, name), size: st.size };
      }
    } catch {
      // folder briefly unavailable; keep polling
    }
    onProgress?.({ downloaded: best?.size ?? 0, total: expectedSize ?? null, speed: 0, external: 'xdm' });
    if (!best) continue;
    stableTicks = best.size === lastSize ? stableTicks + 1 : 0;
    lastSize = best.size;
    const complete = expectedSize ? best.size === expectedSize && stableTicks >= 1 : stableTicks >= 5;
    if (complete) return best.file;
  }
}
