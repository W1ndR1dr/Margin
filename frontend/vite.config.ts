import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}`, import.meta.url));

// Cornerstone3D needs ES-module workers and its WASM codecs left un-prebundled.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // vtk.js drags in xmlbuilder2 (XML IO we never use) which extends node's
      // EventEmitter at import time; without a real class the app dies on boot.
      events: shim('node-events.ts'),
      // Dead node-only branches inside emscripten codec glue and @oozcitak/url.
      fs: shim('node-empty.ts'),
      path: shim('node-empty.ts'),
      url: shim('node-empty.ts'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    // The loader must stay un-prebundled so its `new Worker(new URL(...))`
    // still resolves, but its emscripten codec glue is CJS and has to be
    // converted or native ESM in dev cannot find a default export.
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: [
      'dicom-parser',
      '@cornerstonejs/codec-charls/decodewasmjs',
      '@cornerstonejs/codec-libjpeg-turbo-8bit/decodewasmjs',
      '@cornerstonejs/codec-openjpeg/decodewasmjs',
      '@cornerstonejs/codec-openjph/wasmjs',
    ],
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 4096,
  },
});
