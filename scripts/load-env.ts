/**
 * Loads `.env.local` if it exists, before anything reads `process.env`.
 *
 * Every script here needs a database URL and, sometimes, a Socrata app token.
 * Requiring them to be exported in each shell means a fresh terminal silently
 * loses them, which reads as a broken tool rather than an unset variable.
 *
 * Real environment variables always win: this only fills in what is not set, so
 * a deployment's configuration is never overridden by a file left in a checkout.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ENV_FILES = ['.env.local', '.env'];

for (const file of ENV_FILES) {
  const path = resolve(process.cwd(), file);
  if (!existsSync(path)) continue;
  try {
    // Node's own parser: no dependency, and it does not overwrite existing vars.
    process.loadEnvFile(path);
  } catch (error) {
    console.warn(
      `! Could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
