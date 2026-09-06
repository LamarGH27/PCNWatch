import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The save endpoint's boundary.
 *
 * The database enforces ownership — `user_id` defaults to `auth.uid()`, RLS
 * checks the same value, and suite 06 proves both against real policies. These
 * cover what the endpoint does around that: that it never sends an owner, that
 * it cannot be told to write somebody else's case, and that a rejected write
 * says the same thing whether the case belongs to another user or does not
 * exist at all.
 */

const state = {
  user: null as { id: string } | null,
  rows: [] as Record<string, unknown>[],
  lastInsert: null as Record<string, unknown> | null,
  lastUpdate: null as Record<string, unknown> | null,
};

/**
 * A Supabase stand-in that enforces the same rule the real policy does: a row
 * is only visible, and only updatable, by the user it belongs to.
 */
vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      insert(row: Record<string, unknown>) {
        state.lastInsert = row;
        // The database fills the owner in; the caller never sends one.
        // Real uuids, because the endpoint validates the shape of a case id
        // before it looks anything up — a non-uuid is rejected at the schema.
        const stored = {
          ...row,
          id: `0000000${state.rows.length + 1}-0000-4000-8000-000000000000`,
          user_id: state.user?.id,
        };
        state.rows.push(stored);
        return { select: () => ({ single: async () => ({ data: stored, error: null }) }) };
      },
      update(row: Record<string, unknown>) {
        state.lastUpdate = row;
        return {
          eq(_column: string, id: string) {
            const match = state.rows.find(
              (candidate) => candidate.id === id && candidate.user_id === state.user?.id,
            );
            if (match) Object.assign(match, row);
            return {
              select: () => ({ maybeSingle: async () => ({ data: match ?? null, error: null }) }),
            };
          },
        };
      },
    }),
  }),
  createSupabaseServiceClient: () => null,
}));

vi.mock('@/server/rate-limit', () => ({
  rateLimit: async () => ({ allowed: true, remaining: 10, retryAfterSeconds: 0 }),
}));

import { POST } from '@/app/api/cases/route';

const WESTMINSTER = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'Westminster City Council',
  pcnNumber: 'WM77341902',
  contraventionCode: '12',
  incidentDate: '2026-08-11',
  issueDate: '2026-08-14',
  location: 'Gloucester Place',
  fullAmountPence: 13000,
};

async function post(body: unknown) {
  const response = await POST(
    new Request('http://localhost/api/cases', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  return { status: response.status, json: await response.json() };
}

beforeEach(() => {
  state.user = { id: 'user-a' };
  state.rows = [];
  state.lastInsert = null;
  state.lastUpdate = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('saving a case', () => {
  it('creates one for the signed-in identity', async () => {
    const { status, json } = await post(WESTMINSTER);
    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.caseId).toBeTruthy();
  });

  it('never sends an owner', async () => {
    await post(WESTMINSTER);
    // The strongest form: not "sends the right one" but "sends none at all", so
    // there is no value here that could be wrong.
    expect(state.lastInsert).not.toHaveProperty('user_id');
  });

  it('refuses when there is no identity at all', async () => {
    state.user = null;
    const { status, json } = await post(WESTMINSTER);
    expect(status).toBe(401);
    expect(json.reason).toBe('NOT_SIGNED_IN');
    expect(state.rows).toHaveLength(0);
  });

  it('updates the same case rather than creating a second one', async () => {
    const first = await post(WESTMINSTER);
    const again = await post({ ...WESTMINSTER, caseId: first.json.caseId, location: 'STRAND' });

    expect(again.json.caseId).toBe(first.json.caseId);
    expect(state.rows, 'a correction created a duplicate case').toHaveLength(1);
    expect(state.rows[0]!.location_text).toBe('STRAND');
  });
});

describe('another user’s case id', () => {
  it('cannot be updated by changing the id in the request', async () => {
    const mine = await post(WESTMINSTER);

    // Now a different anonymous identity, using an id it was somehow given.
    state.user = { id: 'user-b' };
    const { status, json } = await post({
      ...WESTMINSTER,
      caseId: mine.json.caseId,
      location: 'HACKED',
    });

    expect(status).toBe(401);
    expect(json.ok).toBe(false);
    // And nothing happened to A's case.
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]!.location_text).toBe('Gloucester Place');
    expect(state.rows[0]!.user_id).toBe('user-a');
  });

  it('does not silently become a new case', async () => {
    // An update that matched no row must not fall back to an insert: a guessed
    // id would then create a case under somebody else's URL.
    state.user = { id: 'user-b' };
    const { status } = await post({
      ...WESTMINSTER,
      caseId: '55555555-5555-4555-8555-555555555555',
    });

    expect(status).toBe(401);
    expect(state.rows).toHaveLength(0);
  });

  it('gets the same answer as for a case that does not exist', async () => {
    const mine = await post(WESTMINSTER);
    state.user = { id: 'user-b' };

    const theirs = await post({ ...WESTMINSTER, caseId: mine.json.caseId });
    const nothing = await post({ ...WESTMINSTER, caseId: '99999999-9999-4999-8999-999999999999' });

    // Telling the two apart is what would let somebody probe for real case ids.
    expect(theirs.status).toBe(nothing.status);
    expect(theirs.json).toEqual(nothing.json);
  });
});

describe('what reaches the row', () => {
  it('writes the account’s existence and not its words', async () => {
    await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [{ kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' }],
        resolvedFacts: [],
      },
    });

    expect(state.lastInsert!.narrative_provided).toBe(true);
    expect(JSON.stringify(state.lastInsert)).not.toMatch(/narrative[^_]/i);
  });

  it('has no field for the account, so a client cannot send one', async () => {
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        narrative: 'My name is Jane Smith of 12 Acacia Avenue.',
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [],
        resolvedFacts: [],
      },
    });

    expect(status).toBe(200);
    const written = JSON.stringify(state.lastInsert);
    for (const secret of ['Jane Smith', 'Acacia Avenue']) {
      expect(written, `${secret} was written to the row`).not.toContain(secret);
    }
  });

  it('rejects an assertion kind outside the vocabulary', async () => {
    const { status } = await post({
      ...WESTMINSTER,
      context: {
        narrativeProvided: true,
        answers: [],
        declaredEvidence: [],
        confirmedAssertions: [{ kind: 'HAS_A_DEFENCE', stance: 'ASSERTED' }],
        resolvedFacts: [],
      },
    });
    expect(status).toBe(400);
    expect(state.rows).toHaveLength(0);
  });

  it('writes nothing about the notice to the logs', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await post(WESTMINSTER);
    await post({ noticeType: 'NOT_A_NOTICE_TYPE', pcnNumber: 'WM77341902' });

    const written = [...error.mock.calls, ...log.mock.calls].flat().join(' ');
    for (const secret of ['WM77341902', 'Gloucester Place', 'Westminster']) {
      expect(written, `"${secret}" was logged`).not.toContain(secret);
    }
  });
});
