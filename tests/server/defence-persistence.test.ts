import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Storing a Defence Pack, and who may read one.
 *
 * The stand-in below applies the row policy the database applies, so "user B
 * cannot read user A's pack" is proved against the same rule production
 * enforces rather than against an application-level comparison that could be
 * forgotten on some future path.
 */

const USER_A = { id: 'aaaaaaaa-0000-4000-8000-00000000000a' };
const USER_B = { id: 'bbbbbbbb-0000-4000-8000-00000000000b' };
const CASE_A = '11111111-1111-4111-8111-111111111111';

interface Row {
  id: string;
  user_id: string;
  case_id: string;
  draft_kind: string;
  pack: unknown;
  generated_body: string;
  edited_body: string | null;
  citations: unknown;
  model: string | null;
  prompt_version: string | null;
  engine_version: string | null;
  version: number;
  generated_at: string | null;
  edited_at: string | null;
  case_fingerprint: string;
  evidence_fingerprint: string;
}

const state = {
  user: USER_A as { id: string } | null,
  rows: [] as Row[],
  failWrite: false,
};

const visible = () => state.rows.filter((row) => row.user_id === state.user?.id);

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: state.user } }) },
    from: () => ({
      select: () => ({
        eq: (_c1: string, v1: string) => ({
          eq: (_c2: string, v2: string) => ({
            maybeSingle: async () => ({
              data: visible().find((r) => r.case_id === v1 && r.draft_kind === v2) ?? null,
              error: null,
            }),
          }),
        }),
      }),
      upsert(row: Record<string, unknown>) {
        return {
          select: () => ({
            single: async () => {
              if (state.failWrite) return { data: null, error: { code: '08006', message: 'gone' } };
              // The database supplies the owner from auth.uid(), as 0018 sets.
              const stored = {
                ...(row as unknown as Row),
                id: `pack-${state.rows.length + 1}`,
                user_id: state.user!.id,
              };
              const existing = state.rows.findIndex(
                (r) => r.case_id === stored.case_id && r.draft_kind === stored.draft_kind,
              );
              if (existing >= 0) {
                stored.id = state.rows[existing]!.id;
                state.rows[existing] = stored;
              } else {
                state.rows.push(stored);
              }
              return { data: stored, error: null };
            },
          }),
        };
      },
      update(patch: Record<string, unknown>) {
        return {
          eq: (_column: string, id: string) => ({
            select: () => ({
              maybeSingle: async () => {
                // RLS: only rows the caller owns are visible to an update.
                const match = visible().find((r) => r.id === id);
                if (match) Object.assign(match, patch);
                return { data: match ?? null, error: null };
              },
            }),
          }),
        };
      },
    }),
  }),
  createSupabaseServiceClient: () => null,
}));

import { loadPack, savePack, saveEditedBody } from '@/server/defence/persist';
import type { DefencePack } from '@/core/defence/types';

const FINGERPRINTS = { caseFingerprint: 'case-1', evidenceFingerprint: 'ev-1' };

const PACK = {
  caseSummary: { pcnNumberMasked: 'WM•••••902', unconfirmed: [] },
  evidence: { items: [], declaredButNotHeld: [] },
  weaknesses: [{ id: 'w1', what: 'No authority photographs.', whyItMatters: '' }],
} as unknown as DefencePack;

const DRAFT = {
  subject: 'Challenge',
  body: 'Dear Sir or Madam, I am writing about the notice.',
  citedReferenceKeys: [],
  factualAssertions: [],
  omittedBecauseUnsupported: [],
  model: 'claude-test',
  promptVersion: 'draft-v1',
  aiLogId: null,
};

async function seed() {
  return savePack({
    caseId: CASE_A,
    pack: PACK,
    draft: DRAFT,
    fingerprints: FINGERPRINTS,
    engineVersion: 'defence-1.0.0',
    previousVersion: 0,
  });
}

beforeEach(() => {
  state.user = USER_A;
  state.rows = [];
  state.failWrite = false;
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe('a pack belongs to its case and its owner', () => {
  it('saves and reads back', async () => {
    await seed();
    const loaded = await loadPack(CASE_A, FINGERPRINTS);

    expect(loaded.kind).toBe('OK');
    expect(loaded.kind === 'OK' && loaded.value?.generatedBody).toContain('Dear Sir or Madam');
    expect(loaded.kind === 'OK' && loaded.value?.version).toBe(1);
    expect(loaded.kind === 'OK' && loaded.value?.staleness.stale).toBe(false);
  });

  it('does not let another user read it by changing the case id', async () => {
    await seed();
    state.user = USER_B;

    const loaded = await loadPack(CASE_A, FINGERPRINTS);
    // Not "forbidden" — nothing. Indistinguishable from a case that does not
    // exist, which is what stops an id in the URL being a way to find one.
    expect(loaded.kind === 'OK' && loaded.value).toBeNull();
  });

  it('does not let another user edit it by guessing a pack id', async () => {
    const saved = await seed();
    const packId = saved.kind === 'OK' ? saved.value.id : '';
    state.user = USER_B;

    const result = await saveEditedBody(packId, 'my replacement letter');
    expect(result.kind).toBe('NOT_FOUND');
    expect(state.rows[0]?.edited_body).toBeNull();
  });

  it('refuses everything with no session', async () => {
    await seed();
    state.user = null;
    expect((await loadPack(CASE_A, FINGERPRINTS)).kind).toBe('NOT_SIGNED_IN');
    expect((await saveEditedBody('pack-1', 'x')).kind).toBe('NOT_SIGNED_IN');
  });
});

describe('editing the letter cannot reach the record', () => {
  it('changes the letter and nothing else', async () => {
    const saved = await seed();
    const packId = saved.kind === 'OK' ? saved.value.id : '';
    const before = { ...state.rows[0]! };

    await saveEditedBody(packId, 'I have rewritten this entirely. The PCN number is XX999.');

    const after = state.rows[0]!;
    expect(after.edited_body).toContain('rewritten');
    // The authoritative half is untouched: pack, fingerprints, generated body,
    // version and provenance all survive an edit unchanged.
    expect(after.pack).toEqual(before.pack);
    expect(after.generated_body).toBe(before.generated_body);
    expect(after.case_fingerprint).toBe(before.case_fingerprint);
    expect(after.evidence_fingerprint).toBe(before.evidence_fingerprint);
    expect(after.version).toBe(before.version);
    expect(after.model).toBe(before.model);
  });

  it('keeps what we drafted underneath the edit', async () => {
    const saved = await seed();
    await saveEditedBody(saved.kind === 'OK' ? saved.value.id : '', 'edited');

    const loaded = await loadPack(CASE_A, FINGERPRINTS);
    expect(loaded.kind === 'OK' && loaded.value?.editedBody).toBe('edited');
    expect(loaded.kind === 'OK' && loaded.value?.generatedBody).toContain('Dear Sir or Madam');
  });
});

describe('regeneration and staleness', () => {
  it('marks a pack stale when the case has moved on', async () => {
    await seed();
    const loaded = await loadPack(CASE_A, {
      caseFingerprint: 'case-2',
      evidenceFingerprint: 'ev-1',
    });

    expect(loaded.kind === 'OK' && loaded.value?.staleness.stale).toBe(true);
    expect(
      loaded.kind === 'OK' && loaded.value?.staleness.stale && loaded.value.staleness.message,
    ).toMatch(/case details have changed/i);
  });

  it('replaces the pack and counts the rebuild', async () => {
    await seed();
    await savePack({
      caseId: CASE_A,
      pack: PACK,
      draft: { ...DRAFT, body: 'A second letter.' },
      fingerprints: { caseFingerprint: 'case-2', evidenceFingerprint: 'ev-2' },
      engineVersion: 'defence-1.0.0',
      previousVersion: 1,
    });

    // One row per case, not a drawer of drafts nobody asked for.
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.version).toBe(2);
    expect(state.rows[0]?.generated_body).toBe('A second letter.');
  });

  it('drops a stale edit on rebuild rather than keeping it over new facts', async () => {
    const saved = await seed();
    await saveEditedBody(saved.kind === 'OK' ? saved.value.id : '', 'written about the old facts');

    await savePack({
      caseId: CASE_A,
      pack: PACK,
      draft: DRAFT,
      fingerprints: { caseFingerprint: 'case-2', evidenceFingerprint: 'ev-2' },
      engineVersion: 'defence-1.0.0',
      previousVersion: 1,
    });

    expect(state.rows[0]?.edited_body).toBeNull();
  });
});

describe('a failed generation costs nothing that already worked', () => {
  it('leaves the previous pack intact when the write fails', async () => {
    await seed();
    state.failWrite = true;

    const result = await savePack({
      caseId: CASE_A,
      pack: PACK,
      draft: { ...DRAFT, body: 'A newer letter' },
      fingerprints: { caseFingerprint: 'case-2', evidenceFingerprint: 'ev-2' },
      engineVersion: 'defence-1.0.0',
      previousVersion: 1,
    });

    expect(result.kind).toBe('UNAVAILABLE');
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]?.generated_body).toContain('Dear Sir or Madam');
    expect(state.rows[0]?.version).toBe(1);
  });

  it('stores the pack with no letter rather than half a letter', async () => {
    /*
     * The letter is the part a model helps with; the sections above it are the
     * product. A failed draft must not cost the user the pack, and must not
     * leave behind a partial letter that reads like a finished one.
     */
    const result = await savePack({
      caseId: CASE_A,
      pack: PACK,
      draft: null,
      fingerprints: FINGERPRINTS,
      engineVersion: 'defence-1.0.0',
      previousVersion: 0,
    });

    expect(result.kind).toBe('OK');
    expect(result.kind === 'OK' && result.value.generatedBody).toBe('');
    expect(state.rows[0]?.pack).toEqual(PACK);
    expect(state.rows[0]?.model).toBeNull();
  });
});
