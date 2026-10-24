import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  configFile: false,
  root,
  build: {
    lib: { entry: path.join(root, '.demo-qr-entry.js'), name: 'DemoQRBundle', formats: ['iife'], fileName: 'qr-bundle' },
    outDir: path.join(root, '.demo-qr-build'),
    emptyOutDir: true,
    minify: true,
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
