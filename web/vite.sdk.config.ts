import { defineConfig } from 'vite';
import { thirdPartyLicenses } from './build/third-party-licenses.ts';

// The browser SDK as one script (dist/sdk/nereus-rum.js, global NereusRUM) that any site
// loads from Nereus; built after the app into the same dist.
export default defineConfig({
  plugins: [thirdPartyLicenses({
    fileName: 'nereus-rum.LICENSE.txt',
    banner: { chunk: 'nereus-rum.js', title: 'Nereus browser SDK. Apache License 2.0, https://github.com/airborne12/Nereus' },
  })],
  build: {
    outDir: 'dist/sdk',
    emptyOutDir: true,
    lib: { entry: 'src/sdk/rum.ts', name: 'NereusRUM', formats: ['iife'], fileName: () => 'nereus-rum.js' },
  },
});
