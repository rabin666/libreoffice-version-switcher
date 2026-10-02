// Hand downloads to Xtreme Download Manager (XDM 7.x).
//
// XDM ignores "-u <url>" when it is the first instance, so lovs starts it in
// the background and sends the request to its local control port, exactly as
// a second "xdman -u ..." invocation would. XDM has no completion callback,
// so lovs watches the output folder instead.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { sleep } from './fsutil.js';
import { isWindows } from './platform.js';

export const XDM_PORT = 9614;
const STARTUP_TIMEOUT_MS = 30_000;
// Without a known size, "finished" means the file stopped growing for this many polls.
const STABLE_POLLS_WITHOUT_SIZE = 5;
// While the file isn't growing, check this often that XDM is still running.
const LIVENESS_CHECK_MS = 10_000;
// XDM reports nothing back, so a download it failed or cancelled looks like a
// stall; give up after this long without any growth.
const STALL_TIMEOUT_MS = 30 * 60_000;

function defaultInstallFolders() {
  if (!isWindows) return ['/opt/xdman', '/usr/lib/xdman', '/usr/bin/xdman'];
  const { ProgramFiles, LOCALAPPDATA } = process.env;
  const programFilesX86 = process.env['ProgramFiles(x86)'];
  return [
    programFilesX86 && path.join(programFilesX86, 'XDM'),
    ProgramFiles && path.join(ProgramFiles, 'XDM'),
    LOCALAPPDATA && path.join(LOCALAPPDATA, 'Programs', 'XDM'),
  ].filter(Boolean);
}

/** XDM ships its own Java runtime; fall back to the system one. */
function javaFor(xdmFolder) {
  const executable = isWindows ? 'javaw.exe' : 'java';
  for (const runtimeDir of ['java-runtime', 'jre']) {
    const candidate = path.join(xdmFolder, runtimeDir, 'bin', executable);
    if (fs.existsSync(candidate)) return candidate;
  }
  return isWindows ? 'javaw' : 'java';
}

/** {command, args, path} that starts XDM from a folder, jar or launcher path. */
function launcherFor(location) {
  let stats;
  try {
    stats = fs.statSync(location);
  } catch {
    return null;
  }
  if (stats.isDirectory()) {
    const jar = path.join(location, 'xdman.jar');
    if (fs.existsSync(jar)) return { command: javaFor(location), args: ['-jar', jar], path: location };
    for (const name of isWindows ? ['xdm-app.exe', 'xdman.exe'] : ['xdman', 'xdm-app']) {
      const executable = path.join(location, name);
      if (fs.existsSync(executable)) return { command: executable, args: [], path: executable };
    }
    return null;
  }
  if (location.toLowerCase().endsWith('.jar')) {
    return { command: javaFor(path.dirname(location)), args: ['-jar', location], path: location };
  }
  return { command: location, args: [], path: location };
}

/** XDM from the configured path, or from the usual install folders; null if absent. */
export function findXdm(xdmPath) {
  for (const location of xdmPath ? [xdmPath] : defaultInstallFolders()) {
    const launcher = launcherFor(location);
    if (launcher) return launcher;
  }
  return null;
}

export function isXdmRunning() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: XDM_PORT });
    const finish = (running) => {
      socket.destroy();
      resolve(running);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/** For the UI and `lovs doctor`: {found, path, running}. */
export async function xdmStatus(xdmPath) {
  const launcher = findXdm(xdmPath);
  return { found: Boolean(launcher), path: launcher?.path ?? null, running: await isXdmRunning() };
}

/** Send "key:value" lines to XDM's control endpoint; resolves with the HTTP status. */
function sendXdmCommand(lines) {
  const body = Buffer.from(lines.map((line) => `${line}\n`).join(''), 'utf8');
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: '127.0.0.1', port: XDM_PORT, path: '/cmd', method: 'GET', headers: { 'Content-Length': body.length } },
      (response) => {
        response.resume();
        resolve(response.statusCode);
      },
    );
    request.setTimeout(10000, () => request.destroy(new Error('XDM did not respond')));
    request.once('error', reject);
    request.end(body);
  });
}

async function ensureXdmRunning(xdmPath, onLog) {
  if (await isXdmRunning()) return;
  const launcher = findXdm(xdmPath);
  if (!launcher) throw new Error('XDM is not running and was not found. Set its location with: lovs config set xdmPath <path>');

  onLog?.(`Starting XDM (${launcher.path})`);
  const child = spawn(launcher.command, [...launcher.args, '-m'], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  for (let waited = 0; waited < STARTUP_TIMEOUT_MS; waited += 500) {
    await sleep(500);
    if (await isXdmRunning()) return;
  }
  throw new Error('XDM did not start within 30 seconds');
}

function cancelledError() {
  return Object.assign(new Error('Cancelled. XDM may still be downloading; stop it from the XDM window.'), { name: 'AbortError' });
}

async function largestFileIn(dir) {
  let largest = null;
  try {
    for (const name of await fsp.readdir(dir)) {
      const file = path.join(dir, name);
      const stats = await fsp.stat(file);
      if (stats.isFile() && (!largest || stats.size > largest.size)) largest = { file, size: stats.size };
    }
  } catch {
    // folder briefly unavailable; the next poll retries
  }
  return largest;
}

/**
 * Queue `url` in XDM, saving into `destDir`, and resolve with the file path
 * once a file of `expectedSize` bytes has appeared and stopped growing.
 */
export async function downloadWithXdm({ url, destDir, fileName, expectedSize, xdmPath, signal, onProgress, onLog }) {
  await ensureXdmRunning(xdmPath, onLog);
  // A fresh folder per download: whatever appears in it is ours, even if XDM renames it.
  await fsp.rm(destDir, { recursive: true, force: true });
  await fsp.mkdir(destDir, { recursive: true });

  const status = await sendXdmCommand([`url:${url}`, `output:${path.join(destDir, fileName)}`, 'quiet:true']);
  if (status !== 200) throw new Error(`XDM rejected the download request (HTTP ${status})`);
  onLog?.('Download handed to XDM; waiting for it to finish');
  // "quiet" is a persistent XDM setting: turn it off again once XDM has taken
  // the request, so browser downloads still show XDM's dialog.
  setTimeout(() => sendXdmCommand(['quiet:false']).catch(() => {}), 5000);

  let previousSize = -1;
  let stablePolls = 0;
  let lastGrowthAt = Date.now();
  let lastLivenessCheckAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw cancelledError();
    await sleep(1000);
    const largest = await largestFileIn(destDir);
    const size = largest?.size ?? 0;
    onProgress?.({ downloaded: size, total: expectedSize ?? null, speed: 0, external: 'xdm' });

    if (largest) {
      stablePolls = size === previousSize ? stablePolls + 1 : 0;
      const complete = expectedSize ? size === expectedSize && stablePolls >= 1 : stablePolls >= STABLE_POLLS_WITHOUT_SIZE;
      if (complete) return largest.file;
    }
    const now = Date.now();
    if (size !== previousSize) lastGrowthAt = now;
    previousSize = size;

    const stalledForMs = now - lastGrowthAt;
    if (stalledForMs >= STALL_TIMEOUT_MS) {
      throw new Error(`XDM made no progress for ${STALL_TIMEOUT_MS / 60_000} minutes; check the XDM window, or use --downloader builtin`);
    }
    if (stalledForMs >= LIVENESS_CHECK_MS && now - lastLivenessCheckAt >= LIVENESS_CHECK_MS) {
      lastLivenessCheckAt = now;
      if (!(await isXdmRunning())) throw new Error('XDM stopped before the download finished');
    }
  }
}
