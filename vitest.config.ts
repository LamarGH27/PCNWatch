import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    // Integration tests need a real PostGIS database and are run by
    // `npm run db:test`, which creates one. See vitest.integration.config.ts.
    exclude: ['tests/e2e/**', 'tests/integration/**', 'node_modules/**'],
  },
});
