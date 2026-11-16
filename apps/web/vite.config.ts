import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // One .env at the repo root serves every workspace; only VITE_* reaches the browser bundle.
  const env = loadEnv(mode, repoRoot, '');
  const apiTarget = `http://localhost:${env.PORT || '3000'}`;
  return {
    envDir: repoRoot,
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': apiTarget, '/healthz': apiTarget, '/readyz': apiTarget },
    },
    preview: { port: 4173, proxy: { '/api': apiTarget } },
    build: { sourcemap: true },
  };
});
