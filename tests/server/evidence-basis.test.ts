import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { validateUpload, evidenceObjectPath } from '@/server/evidence/upload-validation';
import { COMPARISON_CAUTION } from '@/core/evidence/compare';
import { evidenceItem } from '../fixtures/evidence';

/**
 * What uploading evidence does, and does not, do to an assessment.
 *
 * Everything here is checked through `buildCaseView`, the way a real saved case
 * is built, rather than by calling the engine with hand-made counts. The bug
 * this guards against would live in the wiring — one number feeding both "what
 * have I given them?" and "what is backing my case?" — and a test that made its
 * own counts would never see it.
 */

const TODAY = '2026-02-10';

/** How many items of one type actually support the case. */
function providedCount(
  view: ReturnType<typeof buildCaseView>,
  type: string,
): number {
  return view.evidence.items.find((item) => item.type === type)?.itemCount ?? 0;
}

function caseRecord(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pcnNumber: 'CM12345678',
    authorityName: 'Camden',
    authoritySlug: 'camden',
    noticeCategory: 'LOCAL_AUTHORITY_PCN',
    contraventionCode: '12',
    contraventionSuffix: null,
    incidentDate: '2026-01-04',
    issueDate: '2026-01-04',
    noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null,
    locationText: 'Tavistock Place',
    discountDeadlinePrinted: '2026-01-18',
    representationDeadlinePrinted: null,
    parkingLocationSlug: null,
    fullAmountPence: 13000,
    discountedAmountPence: 6500,
    proceduralStage: 'NEW',
    narrativeProvided: true,
    contextAnswers: [],
    confirmedAssertions: [{ kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' }],
    declaredEvidence: [{ type: 'PARKING_APP_RECEIPT', held: 'HAVE' }],
    resolvedFacts: [],
    assertedGroundKeys: [],
    verifiedFields: {
      pcnNumber: true,
      contraventionCode: true,
      incidentDate: true,
      location: true,
      fullAmountPence: true,
    },
    evidenceItems: [],
    noticeSource: 'SCANNED',
    vehicleRegistration: 'AB12 CDE',
    incidentTime: '14:30',
    closedAt: null,
    ...overrides,
  };
}

describe('what an upload is worth to the assessment', () => {
  it('gives a declaration no weight at all', () => {
    // The user has said they hold the receipt. Nobody has seen it.
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
    // Specific to the receipt rather than a total: the case was built from a
    // scanned notice, which legitimately counts as held, and a bare count
    // would now be measuring that instead of the declaration.
    expect(providedCount(view, 'PARKING_APP_RECEIPT')).toBe(0);
    expect(view.assessment.missingInformation.join(' ')).toContain('We have not seen it');
  });

  it('does not let an uploaded file close a gap on its own', () => {
    /*
     * The file exists and the page says so. What it must not do is satisfy the
     * requirement, because nobody — the user included — has looked at what is
     * on it.
     */
    const view = buildCaseView(
      caseRecord({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'UPLOADED')] }),
      TODAY,
    );
    const receipt = view.evidence.items.find((i) => i.type === 'PARKING_APP_RECEIPT');
    expect(receipt?.heldCount).toBe(1);
    expect(receipt?.provided).toBe(false);
    expect(view.evidence.awaitingCheckCount).toBeGreaterThan(0);
    expect(view.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
  });

  it('does not let a confident reading close a gap before the user has checked it', () => {
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('PARKING_APP_RECEIPT', 'ANALYSED', {
            analysis: {
              legibility: 'CLEAR',
              observations: [
                { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE', confidence: 1, status: 'READ' },
              ],
              unreadableRegions: [],
            },
          }),
        ],
      }),
      TODAY,
    );
    expect(providedCount(view, 'PARKING_APP_RECEIPT')).toBe(0);
    expect(view.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
  });

  it('counts a document once the user has confirmed what we read', () => {
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('PCN_IMAGE', 'VERIFIED'),
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED'),
        ],
      }),
      TODAY,
    );
    expect(view.evidence.providedCount).toBeGreaterThan(0);
    expect(view.assessment.basis).toBe('MODERATE_EVIDENCE_BASIS');
  });

  it('gives an unreadable file no weight, however far it was pushed', () => {
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('PCN_IMAGE', 'VERIFIED', { legibility: 'UNREADABLE' }),
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', { legibility: 'UNREADABLE' }),
        ],
      }),
      TODAY,
    );
    expect(providedCount(view, 'PARKING_APP_RECEIPT')).toBe(0);
    expect(view.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
  });

  it('gives a failed reading no weight and keeps the file', () => {
    const failed = evidenceItem('PARKING_APP_RECEIPT', 'UPLOADED', {
      analysisFailure: 'Reading failed before a response was accepted.',
      analysisAttempts: 2,
    });
    const view = buildCaseView(caseRecord({ evidenceItems: [failed] }), TODAY);
    expect(view.evidenceItems[0]?.status).toBe('UPLOADED');
    expect(providedCount(view, 'PARKING_APP_RECEIPT')).toBe(0);
    expect(view.assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
  });
});

describe('what the case view says about confirmed documents', () => {
  it('reports a contradiction between the user’s own document and their notice', () => {
    /*
     * The user paid by app for a different registration. This is the finding
     * they most need and least want, so it has to be produced, not buried.
     */
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
            verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' }],
          }),
        ],
      }),
      TODAY,
    );
    const differing = view.evidenceComparisons.filter((c) => c.outcome === 'DIFFERS');
    expect(differing).toHaveLength(1);

    const finding = view.assessment.findings.find((f) => f.id === 'evidence-comparison');
    expect(finding?.whyItMayMatter).toContain('AB12CDF');
    expect(finding?.confidence).not.toBe('HIGH');
  });

  it('does not turn a match into a defence', () => {
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
            verifiedFacts: [
              { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' },
              { field: 'DATE', value: '2026-01-04' },
            ],
          }),
        ],
      }),
      TODAY,
    );
    const finding = view.assessment.findings.find((f) => f.id === 'evidence-comparison');
    expect(finding).toBeDefined();

    /*
     * Checked against the statements rather than the whole finding, because the
     * finding also carries the caution — and the caution says the words on
     * purpose ("not a view about ... whether you have a ground to rely on").
     * Matching the disclaimer would have this test failing on the sentence that
     * makes the page safe.
     */
    const statements = view.evidenceComparisons.map((c) => c.statement).join(' ');
    for (const forbidden of [/valid defence/i, /will succeed/i, /is invalid/i, /you have a ground/i]) {
      expect(statements).not.toMatch(forbidden);
    }
    expect(finding?.whyItMayMatter).toContain(COMPARISON_CAUTION);
    // A match is not a ground, so no statutory-ground finding appears from one.
    expect(view.assessment.findingsByCategory.STATUTORY_GROUND).toHaveLength(0);
  });

  it('does not demote the authority’s own photographs because the user disputes them', () => {
    /*
     * The invariant from the ranking work, restated for uploaded evidence:
     * material the authority holds can contradict the user, and a product that
     * quietly reweighted it because it disagreed with their account would be
     * building a case out of nothing but their say-so.
     */
    const view = buildCaseView(
      caseRecord({
        evidenceItems: [
          evidenceItem('COUNCIL_PHOTOGRAPHS', 'VERIFIED', {
            verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' }],
          }),
        ],
      }),
      TODAY,
    );
    const comparison = view.evidenceComparisons.find(
      (c) => c.evidenceType === 'COUNCIL_PHOTOGRAPHS',
    );
    expect(comparison?.independent).toBe(true);
    expect(comparison?.outcome).toBe('DIFFERS');

    const finding = view.assessment.findings.find((f) => f.id === 'evidence-comparison');
    expect(finding?.whyItMayMatter).toContain(comparison!.statement);
  });
});

describe('what the server will accept as a file', () => {
  it('refuses anything outside the allowlist', () => {
    for (const type of [
      'application/x-msdownload',
      'application/zip',
      'text/html',
      'image/svg+xml',
      'application/octet-stream',
      '',
    ]) {
      const result = validateUpload({ type, size: 50_000 });
      expect(result.ok, `${type || '(no type)'} was accepted`).toBe(false);
    }
  });

  it('accepts the four formats a parking photograph actually arrives as', () => {
    for (const type of ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']) {
      expect(validateUpload({ type, size: 50_000 }).ok, type).toBe(true);
    }
  });

  it('refuses a file that is too large or empty', () => {
    expect(validateUpload({ type: 'image/jpeg', size: 13 * 1024 * 1024 }).ok).toBe(false);
    expect(validateUpload({ type: 'image/jpeg', size: 0 }).ok).toBe(false);
  });

  it('never lets a filename reach the object path', () => {
    /*
     * The path is what the storage policy checks. A filename is text somebody
     * else chose, and "../../other-user/notice.pdf" must not be able to
     * describe where a file goes.
     */
    const path = evidenceObjectPath(
      '22222222-2222-4222-8222-222222222222',
      '11111111-1111-4111-8111-111111111111',
      'image/jpeg',
      '33333333-3333-4333-8333-333333333333',
    );
    expect(path).toBe(
      '22222222-2222-4222-8222-222222222222/11111111-1111-4111-8111-111111111111/33333333-3333-4333-8333-333333333333.jpg',
    );
    expect(path.split('/')[0]).toBe('22222222-2222-4222-8222-222222222222');
    expect(path).not.toContain('..');
  });
});
