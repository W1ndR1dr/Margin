import { defineConfig } from 'vite';

// Cornerstone3D needs ES-module workers and its WASM codecs left un-prebundled.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8765', changeOrigin: false },
    },
  },
  worker: { format: 'es' },
  optimizeDeps: {
    exclude: ['@cornerstonejs/dicom-image-loader'],
    include: ['dicom-parser'],
  },
  assetsInclude: ['**/*.wasm'],
});
