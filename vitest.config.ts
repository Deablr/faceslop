// Unit/integration tests (Node). Kept separate from vite.config.ts so tests don't load the Start
// and Nitro plugins; test/server-fn-http.test.ts boots the real app config itself.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@': path.join(root, 'src') },
  },
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
