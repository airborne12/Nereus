import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `npm run dev` proxies /api to the API service (API_URL, default http://127.0.0.1:8090).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.API_URL ?? 'http://127.0.0.1:8090' } },
});
