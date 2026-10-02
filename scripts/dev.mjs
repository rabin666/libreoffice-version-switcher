// Development: API server with auto-restart (node --watch) on :5178 and the
// Vite dev server on :5173 (proxies /api to the API). Open http://localhost:5173
import { spawn } from 'node:child_process';

const procs = [
  // --watch restarts on changes to any module index.js loads (api/, cli/,
  // utils/). Not --watch-path: Node only supports that on Windows and macOS.
  spawn(process.execPath, ['--watch', 'index.js', 'ui', '--port', '5178', '--no-open'], {
    stdio: 'inherit',
  }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--open'], { stdio: 'inherit' }),
];

const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const p of procs) p.on('exit', (code) => code && stop());
