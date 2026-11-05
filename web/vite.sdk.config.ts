import { defineConfig } from 'vite';

// The browser SDK as one script (dist/sdk/dorisstack-rum.js, global DorisStackRUM) that any site
// loads from DorisStack; built after the app into the same dist.
export default defineConfig({
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: true,
    lib: { entry: 'src/sdk/rum.ts', name: 'DorisStackRUM', formats: ['iife'], fileName: () => 'dorisstack-rum.js' },
  },
});
