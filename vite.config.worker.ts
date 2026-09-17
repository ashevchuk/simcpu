import { defineConfig } from 'vite';

/** Classic IIFE worker bundle for file:// Spectrum soft-run. */
export default defineConfig({
  build: {
    outDir: 'dist-file',
    emptyOutDir: false,
    lib: {
      entry: 'src/machine/spectrum/spectrumWorker.ts',
      name: 'SpectrumWorker',
      formats: ['iife'],
      fileName: () => 'spectrum-worker.js',
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'spectrum-worker.js',
      },
    },
  },
});
