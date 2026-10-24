import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiPort = Number(process.env.API_PORT || process.env.PORT || 4318);
const devPort = Number(process.env.VITE_PORT || 5173);
const previewPort = Number(process.env.VITE_PREVIEW_PORT || 4173);
const apiProxy = {
  '/api': {
    target: `http://127.0.0.1:${apiPort}`,
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: devPort,
    strictPort: true,
    proxy: apiProxy,
  },
  preview: {
    host: '0.0.0.0',
    port: previewPort,
    strictPort: true,
    proxy: apiProxy,
  },
});
