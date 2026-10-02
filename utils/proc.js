import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './platform.js';

/**
 * Run a command and resolve with {code, stdout, stderr}. Rejects only when
 * the program can't be started. `signal` kills the process.
 */
export function run(command, args = [], { cwd, signal, verbatim = false, input, env } = {}) {
  return new Promise((resolve, reject) => {
    // Never start an installer for an install that is already cancelled.
    if (signal?.aborted) {
      reject(signal.reason ?? Object.assign(new Error('Cancelled'), { name: 'AbortError' }));
      return;
    }
    const child = spawn(command, args, {
      cwd,
      env,
      windowsHide: true,
      windowsVerbatimArguments: verbatim,
      stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      if (err.code === 'ENOENT') err.message = `Command not found: ${command}`;
      reject(err);
    });
    child.once('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.end(input);
  });
}

/** Absolute path of an executable on PATH, or null. */
export function findOnPath(name) {
  const exts = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) return p;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}
