import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/issuer': 'http://127.0.0.1:8787',
      '/rp': 'http://127.0.0.1:8787',
      '/oid4vci': 'http://127.0.0.1:8787',
      '/oid4vp': 'http://127.0.0.1:8787',
    },
  },
});
