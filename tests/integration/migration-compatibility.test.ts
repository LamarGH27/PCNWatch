import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * That 0014 can be applied to the database Production is using today.
 *
 * A migration runs against the live database, not against the branch that
 * motivated it — and the live database is being read by the previous deploy.
 * The first version of 0014 dropped `user_narrative` in the same file that
 * added the new columns, which would have broken every case page the moment it
 * ran: the deployed `getCase` names that column in its select list, and
 * Postgres rejects a select naming a column that does not exist.
 *
 * This builds the intermediate state that a real deployment passes through —
 * migrations applied, deploy not yet done — and checks both codebases against
 * it. The normal test database applies every migration including 0015, so that
 * state cannot be observed there; this test makes its own.
 */

const ADMIN_URL = process.env.PCNWATCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!ADMIN_URL) {
  throw new Error(
    'PCNWATCH_TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated database. ' +
      'Run these through `npm run db:test`, which creates one.',
  );
}

const SCRATCH = 'pcnwatch_compat';
const ROOT = resolve(__dirname, '../..');

/**
 * The select list the deployed build uses, copied from
 * origin/main:src/server/repositories/cases.ts (getCase).
 *
 * A literal rather than something read out of git: this is a record of what was
 * deployed at the time of the change, and it should not start passing because
 * somebody later edited main.
 */
const PRODUCTION_SELECT = `
  select id, pcn_number, authority_name_raw, notice_category, contravention_code,
         contravention_suffix, incident_date, issue_date, location_text,
         full_amount_pence, discounted_amount_pence, procedural_stage, user_narrative,
         asserted_ground_keys, verified_fields, closed_at
    from pcn_cases
`;

/** The select list this branch uses. Kept in step with persist.ts by the test below. */
const NEW_SELECT = `
  select id, pcn_number, vehicle_registration_text, authority_name_raw, notice_type,
         contravention_code, contravention_description, incident_date, incident_time,
         issue_date, location_text, full_amount_pence, discounted_amount_pence,
         discount_deadline_printed, representation_deadline_printed,
         narrative_provided, context_answers, confirmed_assertions, declared_evidence,
         resolved_facts, status, context_revision, updated_at
    from pcn_cases
`;

function migrationsUpTo(limit: string): string[] {
  return readdirSync(resolve(ROOT, 'supabase/migrations'))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .filter((f) => f <= limit);
}

/**
 * The same connection, pointed at a different database.
 *
 * Done by string surgery rather than `new URL()`, which mangles the socket form
 * `postgres://user@/db?host=/var/run/postgresql` — the authority is empty there
 * and the parser does not put it back the way it found it. Both forms keep the
 * database as the last path segment before any query string, so that is what
 * gets replaced.
 */
function urlFor(database: string): string {
  const source = ADMIN_URL as string;
  const queryAt = source.indexOf('?');
  const base = queryAt === -1 ? source : source.slice(0, queryAt);
  const query = queryAt === -1 ? '' : source.slice(queryAt);
  return `${base.slice(0, base.lastIndexOf('/'))}/${database}${query}`;
}

async function run(database: string, sql: string): Promise<void> {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

async function attempt(database: string, sql: string): Promise<{ ok: boolean; message: string }> {
  const client = new Client({ connectionString: urlFor(database) });
  await client.connect();
  try {
    await client.query(sql);
    return { ok: true, message: '' };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${SCRATCH} with (force)`);
  await admin.query(`create database ${SCRATCH}`);
  await admin.end();

  // The state a real deployment is in between "migrations applied" and
  // "application deployed": everything up to and including 0014, and no further.
  await run(SCRATCH, readFileSync(resolve(ROOT, 'supabase/test/00_supabase_shim.sql'), 'utf8'));
  for (const file of migrationsUpTo('0014_case_context_and_anonymous_owners.sql')) {
    await run(SCRATCH, readFileSync(resolve(ROOT, 'supabase/migrations', file), 'utf8'));
  }
}, 120_000);

afterAll(async () => {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  await admin.query(`drop database if exists ${SCRATCH} with (force)`);
  await admin.end();
}, 60_000);

describe('after 0014, before the deploy', () => {
  it('the currently deployed code still works', async () => {
    // The property the first version of 0014 would have broken.
    const result = await attempt(SCRATCH, PRODUCTION_SELECT);
    expect(result.ok, `the deployed query failed: ${result.message}`).toBe(true);
  });

  it('the new code works too', async () => {
    const result = await attempt(SCRATCH, NEW_SELECT);
    expect(result.ok, `the new query failed: ${result.message}`).toBe(true);
  });

  it('0014 does not drop or rename anything', async () => {
    // Expand-only, checked as a property of the file rather than inferred from
    // the two queries above passing.
    const sql = readFileSync(
      resolve(ROOT, 'supabase/migrations/0014_case_context_and_anonymous_owners.sql'),
      'utf8',
    );
    expect(sql).not.toMatch(/drop\s+column/i);
    expect(sql).not.toMatch(/rename\s+column/i);
    expect(sql).not.toMatch(/drop\s+table/i);
  });

  it('adds every column the new persistence needs', async () => {
    const client = new Client({ connectionString: urlFor(SCRATCH) });
    await client.connect();
    const { rows } = await client.query(
      `select column_name from information_schema.columns where table_name = 'pcn_cases'`,
    );
    await client.end();

    const columns = new Set(rows.map((r) => r.column_name as string));
    for (const required of [
      'narrative_provided',
      'context_answers',
      'confirmed_assertions',
      'declared_evidence',
      'resolved_facts',
      'status',
      'context_revision',
      'last_assessed_at',
      'vehicle_registration_text',
      'contravention_description',
      'discount_deadline_printed',
      'representation_deadline_printed',
    ]) {
      expect(columns.has(required), `0014 did not add ${required}`).toBe(true);
    }
    // And the legacy column is still there for the old build to read.
    expect(columns.has('user_narrative'), '0014 removed the column Production reads').toBe(true);
  });

  it('still defaults the owner to the caller', async () => {
    const client = new Client({ connectionString: urlFor(SCRATCH) });
    await client.connect();
    const { rows } = await client.query(
      `select column_default from information_schema.columns
        where table_name = 'pcn_cases' and column_name = 'user_id'`,
    );
    await client.end();
    expect(String(rows[0]?.column_default)).toContain('auth.uid()');
  });
});

describe('after 0015, once the deploy has happened', () => {
  beforeAll(async () => {
    await run(
      SCRATCH,
      readFileSync(resolve(ROOT, 'supabase/migrations/0015_drop_user_narrative.sql'), 'utf8'),
    );
  }, 60_000);

  it('removes the column', async () => {
    const client = new Client({ connectionString: urlFor(SCRATCH) });
    await client.connect();
    const { rows } = await client.query(
      `select 1 from information_schema.columns
        where table_name = 'pcn_cases' and column_name = 'user_narrative'`,
    );
    await client.end();
    expect(rows).toHaveLength(0);
  });

  it('leaves the new code healthy', async () => {
    const result = await attempt(SCRATCH, NEW_SELECT);
    expect(result.ok, `the new query failed after 0015: ${result.message}`).toBe(true);
  });

  it('breaks the old code, which is why it runs after the deploy', async () => {
    // Stated as an assertion rather than left implicit: this is the exact
    // failure the ordering exists to avoid, and it is real.
    const result = await attempt(SCRATCH, PRODUCTION_SELECT);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/user_narrative/);
  });

  it('is safe to apply twice', async () => {
    // Migration runners retry. A second application must not error.
    const result = await attempt(
      SCRATCH,
      readFileSync(resolve(ROOT, 'supabase/migrations/0015_drop_user_narrative.sql'), 'utf8'),
    );
    expect(result.ok, `re-applying 0015 failed: ${result.message}`).toBe(true);
  });
});
