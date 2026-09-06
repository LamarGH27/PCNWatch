/**
 * Does a production server process see the database as configured?
 *
 *   npm run check:runtime-config
 *
 * Answers the question a deployment cannot: not "is the variable set on the
 * platform" but "does the running server resolve it". Those came apart once —
 * Vercel held a correct DATABASE_URL and every page still reported
 * "No Postgres connection configured" — and nothing in the repo could tell the
 * two apart from the outside.
 *
 * Runs the real server environment resolution in a production-mode process,
 * with the shape that broke: a valid DATABASE_URL alongside optional
 * integrations present and blank, which is what a platform holds for features
 * that are not launched yet.
 *
 * Prints no value from any variable — a length and a leading protocol cannot
 * identify a database or authenticate to it.
 */

import './load-env';
import { describeDatabaseUrl } from '../src/server/db/reader';
import { isConfigured } from '../src/lib/env';

const UNLAUNCHED = [
  'ANTHROPIC_API_KEY',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'DTRO_CLIENT_ID',
  'DTRO_CLIENT_SECRET',
  'DTRO_BASE_URL',
  'CAMDEN_PCN_DATASET_URL',
  'INGEST_TRIGGER_SECRET',
];

function main(): void {
  // Reproduce a platform holding blanks for everything not being launched.
  for (const key of UNLAUNCHED) {
    if (process.env[key] === undefined) process.env[key] = '';
  }

  const d = describeDatabaseUrl();

  console.log('\nRUNTIME DATABASE CONFIGURATION');
  console.log('─'.repeat(52));
  console.log(`  DATABASE_URL present         ${d.present}`);
  console.log(`  DATABASE_URL length          ${d.length}`);
  console.log(`  DATABASE_URL protocol valid  ${d.protocolValid}`);
  console.log(`  parsed postgres configured   ${d.parsedConfigured}`);
  console.log(`  isConfigured('database')     ${isConfigured('database')}`);
  console.log(`  environment                  ${d.environment ?? '(none)'}`);
  console.log(`  commit                       ${d.commit ?? '(none)'}`);
  console.log(
    `  blank optional integrations  ${UNLAUNCHED.filter((k) => process.env[k] === '').length} of ${UNLAUNCHED.length}`,
  );

  if (!d.present) {
    console.error(
      '\n✗ DATABASE_URL is not set in this process. Set it and re-run; nothing else here is meaningful without it.\n',
    );
    process.exit(2);
  }

  if (!d.protocolValid) {
    console.error(
      '\n✗ DATABASE_URL does not begin with postgres:// or postgresql://.\n' +
        '  A Supabase *connection string* is wanted here, not the project URL or an API key.\n',
    );
    process.exit(1);
  }

  if (!d.parsedConfigured) {
    console.error(
      '\n✗ The variable is set and well-formed, but the server environment did not resolve it.\n' +
        '  This is the failure this script exists for: something else in the environment is\n' +
        '  invalid and is taking the database down with it. The reason is logged above by\n' +
        '  db.getPool.serverEnv, naming the offending variable.\n',
    );
    process.exit(1);
  }

  console.log('\n✓ A production-mode process resolves DATABASE_URL as configured.');
  console.log('  Blank optional integrations do not disable it.\n');
}

main();
