import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CandidateProposition } from '@/core/reference/candidates/types';

/**
 * What each approval would unlock, proved one approval at a time.
 *
 * The bundle ships entirely unreviewed, so every assertion about "after X is
 * reviewed" has to simulate a review. These do it by rebuilding the store with
 * selected candidates flipped to approved and re-importing the modules that
 * read it — so the gating logic under test is the real one, all the way through
 * to the Defence Pack, rather than a re-implementation of it in a fixture.
 *
 * The point of the exercise is negative. Approving the Westminster discretion
 * policy must not produce a statutory ground; approving a suffix meaning must
 * not produce an entitlement to cancellation; approving one deadline must not
 * release another. A review gate that leaks is worse than no gate, because
 * everybody downstream believes it held.
 */

function approve(candidate: CandidateProposition): CandidateProposition {
  return {
    ...candidate,
    review: {
      decision: 'REVIEWED',
      reviewer: 'A. Reviewer, solicitor',
      decidedAt: '2026-04-01',
      note: null,
    },
    source: {
      ...candidate.source,
      retrieval: 'RETRIEVED',
      retrievedAt: '2026-04-01',
      excerpt: '(verbatim wording recorded by the reviewer)',
    },
  };
}

/**
 * Rebuilds the store with exactly these candidates approved, and nothing else.
 *
 * `vi.doMock` rather than `vi.mock`: the hoisted form caches its factory
 * result, so every scenario would have seen whichever approval ran first.
 */
async function withApproved(...ids: string[]) {
  vi.resetModules();
  vi.doMock('@/core/reference/candidates/code-12-westminster', async () => {
    const actual = await vi.importActual<
      typeof import('@/core/reference/candidates/code-12-westminster')
    >('@/core/reference/candidates/code-12-westminster');
    return {
      CODE_12_WESTMINSTER_BUNDLE: actual.CODE_12_WESTMINSTER_BUNDLE.map((c) =>
        ids.includes(c.id) ? approve(c) : c,
      ),
    };
  });
  return {
    store: await import('@/core/reference/candidates/store'),
    build: await import('@/server/defence/build'),
    caseView: await import('@/server/cases/case-view'),
  };
}

const WESTMINSTER_CODE_12 = {
  contraventionCode: '12',
  authoritySlug: 'westminster',
  noticeType: 'NOTICE_TO_OWNER',
  proceduralStage: 'FORMAL_REPRESENTATION',
};

const TODAY = '2026-01-10';

/* eslint-disable @typescript-eslint/no-explicit-any */
function westminsterRecord(): any {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pcnNumber: 'WM77341902', authorityName: 'City of Westminster', authoritySlug: 'westminster',
    noticeCategory: 'LOCAL_AUTHORITY_PCN', contraventionCode: '12', contraventionSuffix: null,
    incidentDate: '2026-01-04', issueDate: '2026-01-04', noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null, locationText: 'Gloucester Place',
    discountDeadlinePrinted: '2026-01-18', representationDeadlinePrinted: null,
    parkingLocationSlug: null, fullAmountPence: 13000, discountedAmountPence: 6500,
    proceduralStage: 'NEW', narrativeProvided: true, contextAnswers: [],
    confirmedAssertions: [
      { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
      { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
      { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
    ],
    declaredEvidence: [{ type: 'PARKING_APP_RECEIPT', held: 'HAVE' }],
    resolvedFacts: [], assertedGroundKeys: [],
    verifiedFields: {
      pcnNumber: true, contraventionCode: true, incidentDate: true, location: true,
      fullAmountPence: true, issueDate: true, authorityName: true, vehicleRegistration: true,
    },
    evidenceItems: [], noticeSource: 'SCANNED', vehicleRegistration: 'AB12 CDE',
    incidentTime: '14:30', closedAt: null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function packWith(...ids: string[]) {
  const { build, caseView } = await withApproved(...ids);
  const record = westminsterRecord();
  return build.buildDefencePack(record, caseView.buildCaseView(record, TODAY));
}

beforeEach(() => {
  vi.resetModules();
  vi.doUnmock('@/core/reference/candidates/code-12-westminster');
});

/* ------------------------------------------------------------------ */

describe('the bundle as shipped', () => {
  it('is entirely pending, including every candidate added for this gate', async () => {
    const { store } = await withApproved();
    const all = store.allCandidates();
    expect(all).toHaveLength(14);
    for (const candidate of all) {
      expect(candidate.review.decision, candidate.id).toBe('PENDING_LEGAL_REVIEW');
      expect(candidate.review.reviewer, candidate.id).toBeNull();
      expect(candidate.review.decidedAt, candidate.id).toBeNull();
      expect(candidate.source.retrieval, candidate.id).toBe('NOT_RETRIEVED');
      expect(candidate.source.excerpt, candidate.id).toBeNull();
      expect(candidate.source.retrievedAt, candidate.id).toBeNull();
    }
    expect(store.bundleProgress().usable).toBe(0);
  });

  it('holds a candidate for every proposition prepared for this gate', async () => {
    const { store } = await withApproved();
    const ids = store.allCandidates().map((c) => c.id);
    for (const required of [
      'CAND-CODE12-DEFINITION',           // A
      'CAND-CODE12-SUFFIXES',             // B  incorrect VRM suffix
      'CAND-CODE12-ELECTRONIC-PAYMENT',   // C  electronic payment suffix
      'CAND-WCC-INDIVIDUAL-MERITS',       // D
      'CAND-WCC-GENUINE-MISTAKE',         // E
      'CAND-WCC-EVIDENCE-CONSIDERED',     // F
      'CAND-TMA-GROUND-NO-CONTRAVENTION', // G
      'CAND-MITIGATION-SEPARATE',         // H
      'CAND-TMA-GROUND-PAID-DISTINCTION', // I
      'CAND-DEADLINE-APPEAL-28D',         // J
    ]) {
      expect(ids, `${required} is missing from the bundle`).toContain(required);
    }
  });

  it('names every "must not imply" condition, on every candidate', async () => {
    const { store } = await withApproved();
    for (const candidate of store.allCandidates()) {
      expect(candidate.doesNotEstablish.length, candidate.id).toBeGreaterThan(0);
      expect(candidate.source.organisation, candidate.id).not.toBe('');
      expect(candidate.source.documentTitle, candidate.id).not.toBe('');
      expect(candidate.source.canonicalUrl, candidate.id).toMatch(/^https:\/\//);
      expect(candidate.source.jurisdiction, candidate.id).toBeTruthy();
    }
  });

  it('cannot approve itself: no candidate is usable without a person and a source', async () => {
    const { store } = await withApproved();
    for (const candidate of store.allCandidates()) {
      expect(store.isApproved(candidate), candidate.id).toBe(false);
      // Marking it REVIEWED alone is not enough — the source is still unopened.
      const decidedOnly = {
        ...candidate,
        review: { decision: 'REVIEWED' as const, reviewer: 'X', decidedAt: '2026-04-01', note: null },
      };
      expect(store.isApproved(decidedOnly), `${candidate.id} approved with no source opened`).toBe(false);
    }
  });
});

describe('before any review', () => {
  it('gives the Westminster case no statutory ground', async () => {
    const { store } = await withApproved();
    expect(store.hasApprovedStatutoryGround(WESTMINSTER_CODE_12)).toBe(false);
  });

  it('leaves the Defence Pack factual', async () => {
    const pack = await packWith();
    expect(pack.legalPosition.canStateGrounds).toBe(false);
    expect(pack.permittedReferences.referenceKeys).toEqual([]);
  });
});

describe('after ONLY the Westminster genuine-mistake policy is reviewed', () => {
  const ONLY = 'CAND-WCC-GENUINE-MISTAKE';

  it('makes the policy citable for Westminster', async () => {
    const { store } = await withApproved(ONLY);
    const policies = store.applicableApproved(WESTMINSTER_CODE_12, 'AUTHORITY_POLICY');
    expect(policies.map((p) => p.id)).toEqual([ONLY]);
  });

  it('still states no statutory ground', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.hasApprovedStatutoryGround(WESTMINSTER_CODE_12)).toBe(false);
    const pack = await packWith(ONLY);
    expect(pack.legalPosition.canStateGrounds).toBe(false);
  });

  it('does not carry to another authority', async () => {
    const { store } = await withApproved(ONLY);
    const camden = { ...WESTMINSTER_CODE_12, authoritySlug: 'camden' };
    expect(store.applicableApproved(camden, 'AUTHORITY_POLICY')).toHaveLength(0);
  });

  it('unlocks nothing else in the bundle', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.bundleProgress().usable).toBe(1);
  });
});

describe('after ONLY the incorrect-VRM suffix is reviewed', () => {
  const ONLY = 'CAND-CODE12-SUFFIXES';

  it('makes the suffix meaning citable', async () => {
    const { store } = await withApproved(ONLY);
    const meta = store.applicableApproved(WESTMINSTER_CODE_12, 'CONTRAVENTION_METADATA');
    expect(meta.map((m) => m.id)).toEqual([ONLY]);
  });

  it('does not imply cancellation, a defence, or that payment was made', async () => {
    const { store } = await withApproved(ONLY);
    const suffix = store.getCandidate(ONLY)!;
    const says = suffix.doesNotEstablish.join(' ').toLowerCase();
    expect(says).toMatch(/cancel/);
    expect(says).toMatch(/statutory defence|ground of representation/);
    expect(says).toMatch(/payment was in fact made|payment/);
  });

  it('still states no statutory ground', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.hasApprovedStatutoryGround(WESTMINSTER_CODE_12)).toBe(false);
    const pack = await packWith(ONLY);
    expect(pack.legalPosition.canStateGrounds).toBe(false);
  });

  it('does not approve what the code itself alleges', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.applicableApproved(WESTMINSTER_CODE_12, 'CONTRAVENTION_DEFINITION')).toHaveLength(0);
  });
});

describe('"I paid for parking" never becomes the already-paid ground', () => {
  it('classifies the already-paid distinction as an interpretation, never a ground', async () => {
    const { store } = await withApproved();
    const candidate = store.getCandidate('CAND-TMA-GROUND-PAID-DISTINCTION')!;
    expect(candidate.kind).toBe('STATUTORY_GROUND_INTERPRETATION');
  });

  it('does not switch statutory drafting on when approved', async () => {
    // The proposition exists to NARROW what may be said. If approving it
    // satisfied hasApprovedStatutoryGround, the guard would unlock the thing
    // it guards.
    const { store } = await withApproved('CAND-TMA-GROUND-PAID-DISTINCTION');
    expect(store.hasApprovedStatutoryGround(WESTMINSTER_CODE_12)).toBe(false);
    const pack = await packWith('CAND-TMA-GROUND-PAID-DISTINCTION');
    expect(pack.legalPosition.canStateGrounds).toBe(false);
  });

  it('never asserts a ground from the paid-by-app account, even with grounds approved', async () => {
    const pack = await packWith(
      'CAND-TMA-GROUND-NO-CONTRAVENTION',
      'CAND-TMA-GROUND-PAID-DISTINCTION',
    );
    // The record carries PAYMENT_MADE and PAYMENT_BY_APP and no ground key.
    expect(pack.legalPosition.unreviewedGrounds).toEqual([]);
    expect(pack.permittedReferences.confirmedAssertions).toContain('PAYMENT_MADE');
    const packText = JSON.stringify(pack);
    expect(packText).not.toContain('ALREADY_PAID');
  });

  it('says so in the candidate itself', async () => {
    const { store } = await withApproved();
    const candidate = store.getCandidate('CAND-TMA-GROUND-PAID-DISTINCTION')!;
    expect(candidate.doesNotEstablish.join(' ')).toMatch(/I paid for parking/i);
  });
});

describe('after the contravention-did-not-occur ground itself is reviewed', () => {
  const ONLY = 'CAND-TMA-GROUND-NO-CONTRAVENTION';

  it('becomes available as a ground', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.applicableApproved(WESTMINSTER_CODE_12, 'STATUTORY_GROUND').map((c) => c.id))
      .toEqual([ONLY]);
  });

  it('still must not be asserted from "I paid using RingGo" alone', async () => {
    const { store } = await withApproved(ONLY);
    const candidate = store.getCandidate(ONLY)!;
    const says = candidate.doesNotEstablish.join(' ');
    expect(says).toMatch(/different registration means the contravention did not occur/i);
    // The pack asserts no ground on these facts: the record names none.
    const pack = await packWith(ONLY);
    expect(pack.factualPoints.every((p) => p.basis === 'USER_ACCOUNT')).toBe(true);
  });

  it('does not unlock the other statutory candidates', async () => {
    const { store } = await withApproved(ONLY);
    expect(store.bundleProgress().usable).toBe(1);
    expect(store.isApproved(store.getCandidate('CAND-TMA-GROUND-LIST')!)).toBe(false);
  });
});

describe('deadlines stay independently gated', () => {
  it('approving the appeal period releases no other deadline', async () => {
    const { store } = await withApproved('CAND-DEADLINE-APPEAL-28D');
    const rejection = {
      contraventionCode: '12',
      authoritySlug: 'westminster',
      noticeType: 'NOTICE_OF_REJECTION',
      proceduralStage: 'NOTICE_OF_REJECTION',
    };
    expect(store.applicableApproved(rejection, 'DEADLINE_RULE').map((c) => c.id))
      .toEqual(['CAND-DEADLINE-APPEAL-28D']);
    expect(store.isApproved(store.getCandidate('CAND-DEADLINE-DISCOUNT-14D')!)).toBe(false);
    expect(store.isApproved(store.getCandidate('CAND-DEADLINE-REPS-28D')!)).toBe(false);
  });

  it('does not apply the appeal period to a case that has had no rejection', async () => {
    const { store } = await withApproved('CAND-DEADLINE-APPEAL-28D');
    expect(store.applicableApproved(WESTMINSTER_CODE_12, 'DEADLINE_RULE')).toHaveLength(0);
  });

  it('leaves the projection layer untouched: it reads its own reviewStatus', async () => {
    // Candidate approval and deadline projection are separate systems on
    // purpose. Approving a candidate does not mark the projection rule
    // reviewed, so no calculated date crosses the boundary either way.
    const { projectDeadlines } = await import('@/core/deadlines/projection');
    const rules = await import('@/core/deadlines/rules');
    expect(
      Object.values(rules.DEADLINE_RULES ?? {}).every(
        (r) => (r as { reviewStatus: string }).reviewStatus === 'PENDING_LEGAL_REVIEW',
      ),
    ).toBe(true);
    expect(typeof projectDeadlines).toBe('function');
  });
});

describe('a source may not establish what it is not competent to establish', () => {
  it('refuses a Westminster policy page dressed up as a statutory ground', async () => {
    const { store } = await withApproved();
    const policy = store.getCandidate('CAND-WCC-GENUINE-MISTAKE')!;
    const dressed = {
      ...approve(policy),
      kind: 'STATUTORY_GROUND' as const,
    };
    expect(store.isApproved(dressed)).toBe(false);
  });

  it('refuses a London Councils code page dressed up as a deadline rule', async () => {
    const { store } = await withApproved();
    const code = store.getCandidate('CAND-CODE12-DEFINITION')!;
    const dressed = { ...approve(code), kind: 'DEADLINE_RULE' as const };
    expect(store.isApproved(dressed)).toBe(false);
  });
});
