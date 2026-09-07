import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The upload, stage by stage.
 *
 * The first real upload in Preview failed at the row insert, because the insert
 * omitted `user_id`. `pcn_cases` takes its owner from a column default added in
 * 0014 and so its save endpoint correctly sends none; `pcn_evidence` never got
 * that default, so RLS evaluated `with check (user_id = auth.uid())` as
 * `NULL = uuid` — NULL rather than true — and refused the row with 42501.
 *
 * Nothing already written could have caught it. The SQL suite supplied
 * `user_id` explicitly in every insert, which is a shape the application never
 * uses, and the TypeScript tests never reached a policy at all. So the stand-in
 * below enforces the two rules the real database enforces — the row policy and
 * the ownership trigger — and the application's own insert has to satisfy them.
 */

const USER = { id: '9f1c0a52-4c1e-4b1a-9a86-0b5b3a2f11d4' };
const CASE_ID = '2edc68dd-8af4-4fa4-978f-82f7e4c7c0cf';

interface Fail {
  storageUpload?: unknown;
  rowInsert?: unknown;
  objectRemove?: unknown;
}

const state = {
  user: USER as { id: string } | null,
  rows: [] as Record<string, unknown>[],
  objects: new Map<string, string>(),
  removed: [] as string[],
  cases: [CASE_ID],
  fail: {} as Fail,
  storageReady: true,
};

/**
 * The row policy and the ownership trigger, as the database applies them.
 *
 * `with check (user_id = (select auth.uid()))` is not "reject a different
 * user" — it is "accept only where the comparison is true". A null user_id
 * makes it NULL, which is not true, so the row is refused. Reproducing that
 * precisely is the whole point: a stand-in that merely compared non-null ids
 * would have accepted the insert that production refused.
 */
function insertAsDatabase(row: Record<string, unknown>): Record<string, unknown> {
  const owner = row.user_id ?? null;

  if (owner === null || owner !== state.user?.id) {
    throw {
      code: '42501',
      message: 'new row violates row-level security policy for table "pcn_evidence"',
      details: null,
      hint: null,
    };
  }
  if (!state.cases.includes(String(row.case_id))) {
    throw {
      code: '42501',
      message: `Case ${String(row.case_id)} does not belong to user ${String(owner)}`,
      details: null,
      hint: null,
    };
  }
  const stored = { ...row, id: `ev-${state.rows.length + 1}`, created_at: '2026-02-01T10:00:00Z' };
  state.rows.push(stored);
  return stored;
}

vi.mock('@/server/repositories/storage-readiness', () => ({
  getStorageReadiness: async () => ({
    ready: state.storageReady,
    rlsEnabled: true,
    bucketsPresent: 2,
    bucketsPrivate: true,
    policiesPresent: state.storageReady ? 6 : 5,
    policiesExpected: 6,
    missing: state.storageReady ? [] : ['own objects write pcn-evidence'],
  }),
}));

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () =>
            table === 'pcn_cases' && state.cases.includes(CASE_ID)
              ? { data: { id: CASE_ID }, error: null }
              : { data: null, error: null },
        }),
      }),
      insert(row: Record<string, unknown>) {
        return {
          select: () => ({
            single: async () => {
              if (state.fail.rowInsert) return { data: null, error: state.fail.rowInsert };
              try {
                return { data: insertAsDatabase(row), error: null };
              } catch (error) {
                return { data: null, error };
              }
            },
          }),
        };
      },
    }),
    storage: {
      from: () => ({
        async upload(path: string, _file: unknown, options: { contentType: string }) {
          if (state.fail.storageUpload) return { data: null, error: state.fail.storageUpload };
          state.objects.set(path, options.contentType);
          return { data: { path }, error: null };
        },
        async remove(paths: string[]) {
          if (state.fail.objectRemove) return { data: null, error: state.fail.objectRemove };
          for (const path of paths) {
            state.objects.delete(path);
            state.removed.push(path);
          }
          return { data: [], error: null };
        },
      }),
    },
  }),
  createSupabaseServiceClient: () => null,
}));

import { uploadEvidence } from '@/server/evidence/store';

const logLines: string[] = [];

beforeEach(() => {
  state.user = USER;
  state.rows = [];
  state.objects = new Map();
  state.removed = [];
  state.cases = [CASE_ID];
  state.fail = {};
  state.storageReady = true;
  logLines.length = 0;
  vi.spyOn(console, 'error').mockImplementation((line: string) => {
    logLines.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function photograph(name = 'permit-scan.jpg'): File {
  return new File([new Uint8Array(4096).fill(7)], name, { type: 'image/jpeg' });
}

const upload = () =>
  uploadEvidence({ caseId: CASE_ID, evidenceType: 'PERMIT', file: photograph() });

describe('the row insert the first real upload failed on', () => {
  it('attributes the row to the authenticated user', async () => {
    const result = await upload();

    expect(result.kind).toBe('OK');
    expect(state.rows).toHaveLength(1);
    // The regression itself: an insert with no owner is refused by the policy.
    expect(state.rows[0]?.user_id).toBe(USER.id);
  });

  it('stores the file and the row together', async () => {
    const result = await upload();
    expect(result.kind).toBe('OK');

    const path = String(state.rows[0]?.storage_path);
    // The owning user is the first path segment — what the storage policy reads.
    expect(path.startsWith(`${USER.id}/${CASE_ID}/`)).toBe(true);
    expect(state.objects.has(path)).toBe(true);
    expect(state.rows[0]?.status).toBe('UPLOADED');
  });

  it('cannot attach evidence to a case the caller does not own', async () => {
    // RLS returns no case row, so the ownership check answers NOT_FOUND and
    // nothing is written — the same answer as a case that does not exist.
    state.cases = [];
    const result = await upload();

    expect(result.kind).toBe('NOT_FOUND');
    expect(state.rows).toHaveLength(0);
    expect(state.objects.size).toBe(0);
  });
});

describe('a failure names its stage and leaves nothing half-saved', () => {
  it('creates no row when the object cannot be stored', async () => {
    state.fail.storageUpload = Object.assign(new Error('Bucket not found'), {
      name: 'StorageApiError',
      status: 404,
    });

    const result = await upload();

    expect(result.kind).toBe('UNAVAILABLE');
    expect(result.kind === 'UNAVAILABLE' && result.stage).toBe('STORAGE_UPLOAD');
    expect(state.rows).toHaveLength(0);
    expect(state.objects.size).toBe(0);

    const line = logLines.join(' ');
    expect(line).toContain('STORAGE_UPLOAD');
    expect(line).toContain('status=404');
    expect(line).not.toContain('[object Object]');
  });

  it('removes the object when the row cannot be written', async () => {
    /*
     * A stored object with no row is unreachable and undeletable by its owner:
     * nothing lists it, and the delete button it would need does not exist. The
     * row is the only handle on the object.
     */
    state.fail.rowInsert = {
      code: '42501',
      message: 'new row violates row-level security policy for table "pcn_evidence"',
    };

    const result = await upload();

    expect(result.kind).toBe('UNAVAILABLE');
    expect(result.kind === 'UNAVAILABLE' && result.stage).toBe('ROW_INSERT');
    expect(state.rows).toHaveLength(0);
    expect(state.objects.size).toBe(0);
    expect(state.removed).toHaveLength(1);

    const line = logLines.join(' ');
    expect(line).toContain('ROW_INSERT');
    // The exact thing the Preview log could not tell us.
    expect(line).toContain('42501');
    expect(line).toContain('row-level security policy');
  });

  it('records a cleanup that itself failed, rather than reporting success', async () => {
    state.fail.rowInsert = { code: '23505', message: 'duplicate key value' };
    state.fail.objectRemove = { message: 'Object not found', status: 404 };

    const result = await upload();

    expect(result.kind).toBe('UNAVAILABLE');
    // The orphan stays inside the owner's own prefix, so it is not exposed —
    // but it is logged, because nothing else will ever mention it again.
    expect(logLines.join(' ')).toContain('CLEANUP');
  });

  it('refuses before touching the bucket when storage is not ready', async () => {
    state.storageReady = false;

    const result = await upload();

    expect(result.kind).toBe('STORAGE_NOT_READY');
    expect(state.objects.size).toBe(0);
    expect(state.rows).toHaveLength(0);
  });

  it('writes nothing at all when there is no session', async () => {
    state.user = null;

    const result = await upload();

    expect(result.kind).toBe('NOT_SIGNED_IN');
    expect(state.objects.size).toBe(0);
    expect(state.rows).toHaveLength(0);
  });
});

describe('what a failing upload writes to the log', () => {
  it('never logs the filename, the bytes, or the storage path', async () => {
    state.fail.rowInsert = {
      code: '42501',
      message: 'new row violates row-level security policy for table "pcn_evidence"',
    };

    await uploadEvidence({
      caseId: CASE_ID,
      evidenceType: 'PERMIT',
      file: new File([new Uint8Array(4096).fill(7)], 'my-blue-badge-scan.jpg', {
        type: 'image/jpeg',
      }),
    });

    const line = logLines.join(' ');
    // The filename is the user's own words about their document, and the path
    // carries nothing the caseId field is not already saying.
    expect(line).not.toContain('my-blue-badge-scan');
    expect(line).not.toContain('.jpg');
    expect(line).not.toMatch(/[A-Za-z0-9+/]{200,}/); // no base64 payload

    // What it does carry: the ids, the stage, and the reason.
    const payload = JSON.parse(logLines[0]!) as Record<string, unknown>;
    expect(payload.caseId).toBe(CASE_ID);
    expect(payload.stage).toBe('ROW_INSERT');
    expect(String(payload.message)).toContain('42501');
  });
});
