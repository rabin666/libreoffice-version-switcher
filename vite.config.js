import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The UI lives in web_interface/ and is built into dist/ui, which the
// `lovs ui` server (api/server.js) serves. In dev, Vite proxies /api to it.
export default defineConfig({
  root: 'web_interface',
  plugins: [react()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: true,
  },
  // Unit tests cover the Node side (utils/) and live in test/.
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5178', changeOrigin: true },
    },
  },
});
