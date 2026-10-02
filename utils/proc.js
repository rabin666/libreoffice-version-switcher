// Child processes: run a command to completion, find executables on PATH.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isWindows } from './platform.js';

function abortError(signal) {
  return signal.reason ?? Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

/**
 * Run `command` and resolve with {code, stdout, stderr}. Rejects only when it
 * can't be started (or `signal` was already aborted); aborting kills it.
 * `verbatim` passes `args` to Windows unquoted (for msiexec / NSIS syntax).
 */
export function runCommand(command, args = [], { cwd, signal, verbatim = false, input, env } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
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
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    const kill = () => child.kill();
    signal?.addEventListener('abort', kill, { once: true });
    const settle = () => signal?.removeEventListener('abort', kill);

    child.once('error', (err) => {
      settle();
      if (err.code === 'ENOENT') err.message = `Command not found: ${command}`;
      reject(err);
    });
    child.once('close', (code) => {
      settle();
      resolve({ code, stdout, stderr });
    });
    if (input) child.stdin.end(input);
  });
}

/** Absolute path of executable `name` on PATH, or null. */
export function findOnPath(name) {
  const extensions = isWindows ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const extension of extensions) {
      const candidate = path.join(dir, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // not in this folder
      }
    }
  }
  return null;
}
