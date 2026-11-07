import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { thirdPartyLicenses } from './build/third-party-licenses.ts';

// `npm run dev` proxies /api to the API service (API_URL, default http://127.0.0.1:8090).
// `--mode demo` builds the offline demo: relative asset paths, /api answered in the browser.
export default defineConfig(({ mode }) => ({
  plugins: [react(), thirdPartyLicenses({ fileName: 'third-party-licenses.txt' })],
  base: mode === 'demo' ? './' : '/',
  server: { proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' } },
}));
