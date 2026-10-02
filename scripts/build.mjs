// Bundle the CLI + API (index.js and everything it imports) into a single
// CommonJS file, dist/lovs.cjs. That file runs with plain `node` and is the
// input for @yao-pkg/pkg, which handles CJS far more reliably than ESM.
import { build } from 'esbuild';

await build({
  entryPoints: ['index.js'],
  outfile: 'dist/lovs.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: false,
  legalComments: 'none',
  // import.meta.url does not exist in CJS; point it at the bundle itself so
  // api/server.js finds dist/ui next to it (also inside the pkg snapshot).
  define: { 'import.meta.url': '__lovs_import_meta_url' },
  banner: {
    // (esbuild keeps the #! line from index.js above this banner)
    js: "const __lovs_import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  logLevel: 'info',
});
