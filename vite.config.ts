import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import viteReact from '@vitejs/plugin-react';
import { nitro } from 'nitro/vite';
import { defineConfig } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
// Nitro's stock Node server runtime; src/server/node-server.ts wraps it (loopback default + bind guard).
const nitroNodeServer = path.join(
  path.dirname(createRequire(import.meta.url).resolve('nitro/package.json')),
  'dist/presets/node/runtime/node-server.mjs',
);

export default defineConfig({
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  build: {
    // React + Router + Query + React Aria + Effect in one local-only app; size is not a concern here.
    chunkSizeWarningLimit: 1024,
  },
  server: {
    // Loopback only by default: the app carries the user's Facebook session.
    host: '127.0.0.1',
    port: 3000,
    strictPort: true,
  },
  plugins: [
    // Order matters: Start before React.
    tanstackStart({
      serverFns: {
        // faceslop's own request middleware (src/start.ts) owns CSRF: x-faceslop header + Origin check.
        disableCsrfMiddlewareWarning: true,
      },
    }),
    nitro({
      preset: 'node-server',
      entry: path.join(root, 'src/server/node-server.ts'),
      alias: { '#faceslop/nitro-node-server': nitroNodeServer },
      rolldownConfig: {
        onwarn(warning, warn) {
          // TanStack packages ship "use client" directives; meaningless in the server bundle.
          if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
          warn(warning);
        },
      },
    }),
    viteReact(),
    tailwindcss(),
  ],
});
