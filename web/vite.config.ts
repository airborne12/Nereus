import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies /api to the API service (API_URL, default http://127.0.0.1:8090).
// `--mode demo` builds the offline demo: relative asset paths, /api answered in the browser.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === 'demo' ? './' : '/',
  server: { proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' } },
}));
