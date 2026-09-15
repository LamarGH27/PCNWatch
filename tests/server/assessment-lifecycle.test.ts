import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Recording that an assessment completed.
 *
 * `markAssessed` has existed since 0014 and was never called, so
 * `pcn_cases.status` sat at VERIFIED for every case ever saved and
 * `last_assessed_at` was permanently null — which is why the funnel could not
 * say how many assessments actually finished.
 *
 * Wiring it in is only safe if it records and does nothing else. These tests
 * pin both halves: that the fact is recorded when an assessment succeeds, and
 * that the assessment the user receives is byte-for-byte what it would have
 * been without any of this.
 */

const state = {
  marked: [] as string[],
  markThrows: false,
};

vi.mock('@/server/cases/persist', () => ({
  markAssessed: async (caseId: string) => {
    if (state.markThrows) throw new Error('datastore unavailable');
    state.marked.push(caseId);
  },
}));

vi.mock('@/server/rate-limit', () => ({
  rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
}));

const { POST } = await import('@/app/api/cases/assess/route');

const CASE_ID = '33333333-3333-4333-8333-333333333333';

/** The minimum body the endpoint's schema accepts. */
function body(extra: Record<string, unknown> = {}) {
  return {
    noticeType: 'PCN_ON_STREET',
    noticeCategory: 'COUNCIL',
    proceduralStage: 'INFORMAL_CHALLENGE_WINDOW',
    ...extra,
  };
}

function request(payload: Record<string, unknown>) {
  return new Request('https://pcnwatch.co.uk/api/cases/assess', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  state.marked = [];
  state.markThrows = false;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('assessment completion is recorded', () => {
  it('marks the case once the assessment has been produced', async () => {
    const response = await POST(request(body({ caseId: CASE_ID })));
    const payload = (await response.json()) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(state.marked).toEqual([CASE_ID]);
  });

  it('records nothing when there is no saved case to record against', async () => {
    // A save can fail without costing the user their assessment, and when it
    // does there is no row to mark. That path must not invent one.
    const response = await POST(request(body()));
    const payload = (await response.json()) as { ok: boolean };

    expect(payload.ok).toBe(true);
    expect(state.marked).toEqual([]);
  });

  it('records nothing when the request never produced an assessment', async () => {
    const response = await POST(
      request({ noticeType: 'NOT_A_NOTICE_TYPE', caseId: CASE_ID }),
    );

    expect(response.status).toBe(400);
    expect(state.marked).toEqual([]);
  });
});

describe('recording never costs the user their assessment', () => {
  it('returns the same assessment whether or not a case id was sent', async () => {
    const withCase = await (await POST(request(body({ caseId: CASE_ID })))).json();
    const withoutCase = await (await POST(request(body()))).json();

    /*
     * The whole safety claim in one assertion: sending a case id changes what
     * is *recorded* and nothing about what is *returned*. If wiring this in had
     * altered the reasoning, the legal conclusions, the evidence handling or
     * the Defence Pack eligibility carried in the payload, these two would
     * differ.
     */
    expect(withCase).toEqual(withoutCase);
  });

  it('still returns the assessment when recording fails', async () => {
    state.markThrows = true;

    const response = await POST(request(body({ caseId: CASE_ID })));

    // A metric is worth strictly less than the thing the user came for.
    expect(response.status).toBe(200);
    expect(((await response.json()) as { ok: boolean }).ok).toBe(true);
  });
});
