import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The dashboard is served at `/app/*` from S3 through the same distribution
 * (ADR-0006), so it is built with that base and never owns the root.
 *
 * In dev, Vite serves `/app/*` itself and proxies everything else to the local
 * handler server — the same split the distribution makes at the edge.
 */
export default defineConfig({
  base: '/app/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    // Content-hashed assets are served `immutable`, so a deploy needs no
    // invalidation (ADR-0006).
    assetsDir: 'assets',
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '^/(?!app/|@|node_modules/|src/).*': {
        target: `http://localhost:${process.env['DEV_SERVER_PORT'] ?? 3000}`,
        changeOrigin: false,
      },
    },
  },
});
