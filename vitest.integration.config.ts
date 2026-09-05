import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Tests that need a real PostGIS database.
 *
 * Kept out of `npm test` because they cannot run without one, and run by
 * `npm run db:test` after the migrations are applied. They are deliberately not
 * written to skip when no database is present: a suite that silently passes
 * without checking anything is worse than one that is not run at all.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    // A full ingestion against a real database is slower than a unit test.
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // The suites share one database and publish to the same authority.
    fileParallelism: false,
  },
});
