import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { toCaseRow, fromCaseRow } from '@/server/cases/persist';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';

/**
 * Saving and resuming a case against the real policies.
 *
 * The unit tests mock Supabase and prove what the endpoint sends. This proves
 * what the database does with it: that the row the mapper writes is a row this
 * schema accepts, that `user_id` really does default to the caller's identity,
 * that RLS really does hide one anonymous user's case from another, and that a
 * case read back through the real column types rebuilds the same assessment.
 *
 * A mock cannot establish any of that — it returns whatever shape the test
 * author believed the database used, which is exactly how the map search
 * shipped broken.
 */

const DATABASE_URL = process.env.PCNWATCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'PCNWATCH_TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated database. ' +
      'Run these through `npm run db:test`, which creates one.',
  );
}

const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });

const USER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const USER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

const WESTMINSTER: VerifiedFacts = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'Westminster City Council',
  pcnNumber: 'WM77341902',
  vehicleRegistration: 'LT19XYZ',
  contraventionCode: '12',
  contraventionDescription: 'Parked in a residents’ bay without a valid permit',
  incidentDate: '2026-08-11',
  incidentTime: '14:32',
  issueDate: '2026-08-14',
  location: 'Gloucester Place',
  fullAmountPence: 13000,
  discountedAmountPence: 6500,
  discountDeadlinePrinted: '2026-08-28',
};

const RINGGO: UserContext = {
  ...EMPTY_USER_CONTEXT,
  narrativeProvided: true,
  answers: [{ questionId: 'GENERAL#council-photographs', answer: 'NO' }],
  declaredEvidence: [{ type: 'PARKING_APP_RECEIPT', held: 'HAVE' }],
  confirmedAssertions: [
    { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
    { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
    { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
  ],
  resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
};

/**
 * Runs a block as one authenticated identity, exactly as a PostgREST request
 * would: the `authenticated` role plus the JWT subject claim RLS reads.
 */
async function asUser<T>(userId: string, work: (run: Runner) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query("set local role authenticated");
    await client.query('select set_config($1, $2, true)', ['request.jwt.claim.sub', userId]);
    const result = await work((sql, params) => client.query(sql, params));
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

type Runner = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;

/** The insert the application makes: every column except the owner. */
function insertSql(row: Record<string, unknown>) {
  const keys = Object.keys(row);
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  return {
    text: `insert into pcn_cases (${keys.join(', ')}) values (${placeholders}) returning id`,
    values: keys.map((key) => {
      const value = row[key];
      // jsonb columns take a string; everything else goes through as-is.
      return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
    }),
  };
}

const SELECT_COLUMNS = `
  id, pcn_number, vehicle_registration_text, authority_name_raw, notice_type,
  contravention_code, contravention_description, incident_date, incident_time,
  issue_date, location_text, full_amount_pence, discounted_amount_pence,
  discount_deadline_printed, representation_deadline_printed,
  narrative_provided, context_answers, confirmed_assertions, declared_evidence,
  resolved_facts, status, context_revision, updated_at
`;

/** Postgres returns dates as Date objects; the reader expects the ISO day. */
function normaliseRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  for (const key of ['incident_date', 'issue_date', 'discount_deadline_printed', 'representation_deadline_printed']) {
    const value = out[key];
    if (value instanceof Date) out[key] = value.toISOString().slice(0, 10);
  }
  return out;
}

beforeAll(async () => {
  await pool.query('delete from pcn_cases where user_id = any($1)', [[USER_A, USER_B]]);
  await pool.query('delete from auth.users where id = any($1)', [[USER_A, USER_B]]);
  // Two anonymous identities. Supabase would create these through
  // signInAnonymously; what matters is that they are ordinary auth.users rows.
  await pool.query('insert into auth.users (id, email) values ($1, null), ($2, null)', [USER_A, USER_B]);
});

afterAll(async () => {
  await pool.query('delete from pcn_cases where user_id = any($1)', [[USER_A, USER_B]]);
  await pool.query('delete from auth.users where id = any($1)', [[USER_A, USER_B]]);
  await pool.end();
});

describe('an anonymous user saves and resumes a case', () => {
  let caseId = '';

  it('creates the case without naming its owner', async () => {
    const row = toCaseRow(WESTMINSTER, RINGGO);
    expect(Object.keys(row)).not.toContain('user_id');

    caseId = await asUser(USER_A, async (run) => {
      const { text, values } = insertSql(row);
      const result = await run(text, values);
      return String(result.rows[0]!.id);
    });

    expect(caseId).toMatch(/^[0-9a-f-]{36}$/);

    // The database filled the owner in from the session.
    const owner = await pool.query('select user_id from pcn_cases where id = $1', [caseId]);
    expect(owner.rows[0]!.user_id).toBe(USER_A);
  });

  it('rebuilds the same assessment the user saw before they left', async () => {
    const stored = await asUser(USER_A, async (run) => {
      const result = await run(`select ${SELECT_COLUMNS} from pcn_cases where id = $1`, [caseId]);
      return fromCaseRow(normaliseRow(result.rows[0]!));
    });

    expect(stored.facts).toEqual(WESTMINSTER);
    expect(stored.context).toEqual(RINGGO);

    // The property the whole design rests on: the assessment is regenerated,
    // not stored, and regeneration is faithful.
    expect(assessVerifiedNotice(stored.facts, stored.context)).toEqual(
      assessVerifiedNotice(WESTMINSTER, RINGGO),
    );
  });

  it('stores no trace of the account itself', async () => {
    const row = await pool.query('select * from pcn_cases where id = $1', [caseId]);
    const written = JSON.stringify(row.rows[0]);

    // The row records that an account was written and nothing of what it said.
    expect(row.rows[0]!.narrative_provided).toBe(true);
    for (const secret of ['RingGo', 'registration was wrong', 'Jane', 'hospital']) {
      expect(written, `"${secret}" reached the row`).not.toContain(secret);
    }
    // And the column it could have gone in no longer exists.
    expect(Object.keys(row.rows[0]!)).not.toContain('user_narrative');
  });

  it('keeps the case saved even though no assessment was stored', async () => {
    const row = await pool.query('select status from pcn_cases where id = $1', [caseId]);
    // VERIFIED, not ASSESSED: the save happens first so that an assessment that
    // fails cannot cost the user the details they confirmed.
    expect(row.rows[0]!.status).toBe('VERIFIED');
  });

  it('lists the case for its owner and nobody else', async () => {
    const mine = await asUser(USER_A, (run) => run('select id from pcn_cases'));
    expect(mine.rows).toHaveLength(1);

    const theirs = await asUser(USER_B, (run) => run('select id from pcn_cases'));
    expect(theirs.rows, 'another anonymous user could see the case').toHaveLength(0);
  });
});

describe('a second anonymous user', () => {
  let caseId = '';

  beforeAll(async () => {
    const result = await pool.query('select id from pcn_cases where user_id = $1 limit 1', [USER_A]);
    caseId = String(result.rows[0]!.id);
  });

  it('cannot read the case even knowing its id', async () => {
    // The URL-manipulation case. Being given an id must not be enough.
    const seen = await asUser(USER_B, (run) =>
      run('select id from pcn_cases where id = $1', [caseId]),
    );
    expect(seen.rows).toHaveLength(0);
  });

  it('cannot update or delete it', async () => {
    const updated = await asUser(USER_B, (run) =>
      run('update pcn_cases set location_text = $1 where id = $2', ['HACKED', caseId]),
    );
    expect(updated.rowCount).toBe(0);

    const deleted = await asUser(USER_B, (run) =>
      run('delete from pcn_cases where id = $1', [caseId]),
    );
    expect(deleted.rowCount).toBe(0);

    // A's case is untouched.
    const after = await pool.query('select location_text from pcn_cases where id = $1', [caseId]);
    expect(after.rows[0]!.location_text).toBe('Gloucester Place');
  });

  it('cannot create a case owned by somebody else', async () => {
    await expect(
      asUser(USER_B, (run) =>
        run('insert into pcn_cases (user_id, notice_type) values ($1, $2)', [USER_A, 'PCN_POSTAL']),
      ),
    ).rejects.toThrow();
  });
});

describe('several cases', () => {
  it('stay separate, and stay with their owner', async () => {
    await asUser(USER_A, async (run) => {
      const second = toCaseRow({ ...WESTMINSTER, pcnNumber: 'WM00002222' }, EMPTY_USER_CONTEXT);
      const { text, values } = insertSql(second);
      await run(text, values);
    });

    await asUser(USER_B, async (run) => {
      const theirs = toCaseRow({ ...WESTMINSTER, pcnNumber: 'BB00003333' }, EMPTY_USER_CONTEXT);
      const { text, values } = insertSql(theirs);
      await run(text, values);
    });

    const a = await asUser(USER_A, (run) => run('select pcn_number from pcn_cases'));
    const b = await asUser(USER_B, (run) => run('select pcn_number from pcn_cases'));

    expect(a.rows.map((r) => r.pcn_number).sort()).toEqual(['WM00002222', 'WM77341902']);
    expect(b.rows.map((r) => r.pcn_number)).toEqual(['BB00003333']);
  });
});

describe('the shape guards hold', () => {
  it('refuses a context column that is not an array', async () => {
    await expect(
      pool.query(
        'insert into pcn_cases (user_id, notice_type, confirmed_assertions) values ($1, $2, $3)',
        [USER_A, 'PCN_POSTAL', JSON.stringify({ not: 'an array' })],
      ),
    ).rejects.toThrow(/pcn_cases_context_shapes/);
  });

  it('will not create an ownerless case, even as the service role', async () => {
    // auth.uid() is null outside a session, and the column is not null — so a
    // service-role insert has to name its owner rather than silently creating
    // a row nobody can reach.
    await expect(
      pool.query('insert into pcn_cases (notice_type) values ($1)', ['PCN_POSTAL']),
    ).rejects.toThrow();
  });
});
