/**
 * Creates a local PCNWatch database ready for real ingestion.
 *
 *   npm run db:setup
 *   PCNWATCH_DB=mydb npm run db:setup
 *
 * Uses the `pg` client the ingestion pipeline already depends on, rather than
 * shelling out to `psql`. A Postgres container has psql inside it but the host
 * usually does not, and "psql: command not found" after a successful
 * `docker run` is a confusing place to land. Node is already required to run
 * anything here, so this works wherever the rest of the project does.
 *
 * Connection details come from the standard PG* environment variables, or from
 * DATABASE_URL. Safe to re-run: it drops and recreates the database.
 */
import './load-env';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client, type ClientConfig } from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const DB = process.env.PCNWATCH_DB ?? 'pcnwatch';

/** Postgres takes a few seconds to accept connections after its container starts. */
const STARTUP_TIMEOUT_MS = 30_000;

function baseConfig(database: string): ClientConfig {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${database}`;
    return { connectionString: url.toString() };
  }
  return {
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD,
    database,
  };
}

async function connect(database: string, waitForStartup = false): Promise<Client> {
  const deadline = Date.now() + (waitForStartup ? STARTUP_TIMEOUT_MS : 0);
  let announced = false;

  for (;;) {
    const client = new Client(baseConfig(database));
    try {
      await client.connect();
      if (announced) process.stdout.write('\n');
      return client;
    } catch (error) {
      await client.end().catch(() => {});
      const message = error instanceof Error ? error.message : String(error);
      const startingUp = /ECONNREFUSED|starting up|not yet accepting/i.test(message);
      if (!startingUp || Date.now() >= deadline) {
        fail(`Could not connect to PostgreSQL: ${message}`, connectionHelp());
      }
      if (!announced) {
        process.stdout.write('→ waiting for PostgreSQL to accept connections');
        announced = true;
      }
      process.stdout.write('.');
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

function connectionHelp(): string[] {
  return [
    'Start one with Docker:',
    '  docker run -d --name pcnwatch-db -p 5432:5432 \\',
    '    -e POSTGRES_PASSWORD=postgres postgis/postgis:16-3.4',
    '',
    'Then set the connection details:',
    '  export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres',
    '',
    'PostGIS is required — the plain `postgres` image will not work.',
  ];
}

function fail(message: string, detail: readonly string[] = []): never {
  console.error(`\n✗ ${message}\n`);
  for (const line of detail) console.error(`  ${line}`);
  console.error('');
  process.exit(1);
}

/** Runs a whole .sql file as one simple query, the way `psql -f` does. */
async function applyFile(client: Client, path: string): Promise<void> {
  const sql = readFileSync(path, 'utf8');
  try {
    await client.query(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`${path.replace(`${ROOT}/`, '')} failed: ${message}`);
  }
}

async function main(): Promise<void> {
  const admin = await connect('postgres', true);

  console.log(`→ recreating database ${DB}`);
  await admin.query(`drop database if exists ${quoteIdent(DB)} with (force)`);
  await admin.query(`create database ${quoteIdent(DB)}`);
  await admin.end();

  const db = await connect(DB);

  console.log('→ applying Supabase shim (local only — a hosted project supplies this itself)');
  await applyFile(db, resolve(ROOT, 'supabase/test/00_supabase_shim.sql'));

  console.log('→ applying migrations');
  const migrations = readdirSync(resolve(ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of migrations) {
    console.log(`   ${file}`);
    await applyFile(db, resolve(ROOT, 'supabase/migrations', file));
  }

  console.log('→ seeding authorities, products and the Camden source');
  await applyFile(db, resolve(ROOT, 'supabase/seed/001_reference.sql'));

  // Prove PostGIS is actually there rather than discovering it mid-ingestion.
  const postgis = await db.query<{ installed: boolean }>(
    "select count(*) > 0 as installed from pg_extension where extname = 'postgis'",
  );
  if (!postgis.rows[0]?.installed) {
    fail('PostGIS is not installed in this database.', connectionHelp());
  }

  await db.end();

  const url = databaseUrlFor(DB);
  console.log(`\n✓ Database ${DB} is ready.\n`);
  console.log('  Add this to .env.local so the scripts pick it up automatically:');
  console.log(`    DATABASE_URL="${url}"\n`);
}

function quoteIdent(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
    fail(`Refusing to use ${JSON.stringify(name)} as a database name.`);
  }
  return `"${name}"`;
}

function databaseUrlFor(database: string): string {
  if (process.env.DATABASE_URL) {
    const url = new URL(process.env.DATABASE_URL);
    url.pathname = `/${database}`;
    return url.toString();
  }
  const user = process.env.PGUSER ?? 'postgres';
  const password = process.env.PGPASSWORD ? `:${process.env.PGPASSWORD}` : '';
  const host = process.env.PGHOST ?? 'localhost';
  const port = process.env.PGPORT ?? '5432';
  return `postgres://${user}${password}@${host}:${port}/${database}`;
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
