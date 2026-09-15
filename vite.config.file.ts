import { defineConfig, type Plugin } from 'vite';

/**
 * Build a double-clickable `dist-file/` tree for the `file://` protocol.
 *
 * Browsers refuse ES-module scripts on `file://` (opaque origin / CORS), so
 * this config emits one classic IIFE bundle and strips `type="module"` from
 * the generated HTML. Relative `base: './'` keeps script paths valid when
 * the HTML is opened from disk.
 */
function classicScriptsForFileProtocol(): Plugin {
  return {
    name: 'classic-scripts-for-file-protocol',
    transformIndexHtml(html) {
      // Modules are deferred; a classic <script> in <head> would run before
      // #stage exists and crash main.ts. `defer` restores module timing.
      // Cache-bust query so file:// reloads pick up a fresh app.js.
      const v = Date.now().toString(36);
      return html
        .replace(/<link rel="modulepreload"[^>]*>\s*/g, '')
        .replace(
          /<script type="module" crossorigin src="([^"]+)"><\/script>/g,
          `<script src="$1?v=${v}" defer><\/script>`,
        )
        .replace(
          /<script type="module" src="([^"]+)"><\/script>/g,
          `<script src="$1?v=${v}" defer><\/script>`,
        );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [classicScriptsForFileProtocol()],
  build: {
    outDir: 'dist-file',
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: 'index.html',
      output: {
        format: 'iife',
        name: 'Z80CircuitSim',
        inlineDynamicImports: true,
        entryFileNames: 'app.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
