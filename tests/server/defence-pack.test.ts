import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { buildDefencePack, maskPcnNumber } from '@/server/defence/build';
import { establishedFacts } from '@/server/defence/generate';
import { checkStaleness, fingerprintCase } from '@/server/defence/fingerprint';
import { evidenceItem } from '../fixtures/evidence';

/**
 * What a Defence Pack is made of.
 *
 * The premise of the product is that it is worth paying for because it is
 * *true* — everything in it traces to something the user confirmed, and the
 * parts that cannot be established are named rather than filled in. Every test
 * here is about one of those two halves.
 */

const TODAY = '2026-02-10';

function caseRecord(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    pcnNumber: 'WM77341902',
    authorityName: 'City of Westminster',
    authoritySlug: 'westminster',
    noticeCategory: 'LOCAL_AUTHORITY_PCN',
    contraventionCode: '12',
    contraventionSuffix: null,
    incidentDate: '2026-01-04',
    issueDate: '2026-01-04',
    noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null,
    locationText: 'Gloucester Place',
    discountDeadlinePrinted: '2026-01-18',
    representationDeadlinePrinted: null,
    parkingLocationSlug: null,
    fullAmountPence: 13000,
    discountedAmountPence: 6500,
    proceduralStage: 'NEW',
    narrativeProvided: true,
    contextAnswers: [],
    confirmedAssertions: [
      { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
      { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
    ],
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
    vehicleRegistration: 'AB12 CDE',
    incidentTime: '14:30',
    closedAt: null,
    ...overrides,
  };
}

function pack(overrides: Partial<CaseRecord> = {}) {
  const record = caseRecord(overrides);
  return buildDefencePack(record, buildCaseView(record, TODAY));
}

describe('A. the case summary uses confirmed facts and nothing else', () => {
  it('leaves out a field the user never confirmed, and names it', () => {
    const built = pack({
      verifiedFields: { pcnNumber: true, contraventionCode: true, incidentDate: true },
    });

    // The location and the amount were never ticked, so they are not in a
    // document that will be read as the user's own statement of their case.
    expect(built.caseSummary.location).toBeNull();
    expect(built.caseSummary.amount).toBeNull();
    expect(built.caseSummary.unconfirmed).toContain('The location on the notice');
    expect(built.caseSummary.unconfirmed).toContain('The amount demanded');
  });

  it('masks the PCN number wherever the pack shows it', () => {
    expect(maskPcnNumber('WM77341902')).toBe('WM•••••902');
    expect(maskPcnNumber('WM77341902')).not.toContain('7734');
    expect(pack().caseSummary.pcnNumberMasked).not.toContain('77341902');
  });
});

describe('B. the account stays the user’s account', () => {
  it('attributes everything the user said, and never restates it as a finding', () => {
    const built = pack();
    expect(built.account.userSays.length).toBeGreaterThan(0);
    for (const statement of built.account.userSays) {
      expect(statement.source).toBe('CONFIRMED_USER_ASSERTION');
    }
  });

  it('cannot carry an assertion the user never confirmed', () => {
    const built = pack({ confirmedAssertions: [] });
    expect(built.account.userSays).toEqual([]);
    // And it cannot leak in through the drafting material either.
    expect(establishedFacts(built).some((f) => f.source === 'CONFIRMED_USER_ASSERTION')).toBe(false);
  });
});

describe('C. evidence means evidence we hold', () => {
  it('does not treat a declared-only item as evidence', () => {
    /*
     * The user says they have the RingGo receipt. Nobody has seen it. It
     * appears as a gap, and the pack says in as many words that it is not
     * claiming the document exists.
     */
    const built = pack();
    expect(built.evidence.items).toEqual([]);
    expect(built.evidence.declaredButNotHeld).toContain('Parking app session');
    expect(built.weaknesses.some((w) => w.id.startsWith('weak-declared-'))).toBe(true);
  });

  it('does not treat an uploaded but unchecked item as evidence', () => {
    const built = pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'ANALYSED')] });
    expect(built.evidence.items).toEqual([]);
  });

  it('uses an item the user has confirmed', () => {
    const built = pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED')] });
    expect(built.evidence.items).toHaveLength(1);
    expect(built.evidence.items[0]?.verifiedFacts[0]?.source).toBe('VERIFIED_EVIDENCE_FACT');
  });
});

describe('D and E. the RingGo scenario, both halves of it', () => {
  const wrongVrm = () =>
    pack({
      evidenceItems: [
        evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
          verifiedFacts: [
            { field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' },
            { field: 'DATE', value: '2026-01-04' },
          ],
        }),
      ],
    });

  it('states the difference as a factual point, not as a legal conclusion', () => {
    const built = wrongVrm();
    const point = built.factualPoints.find((p) => p.id.startsWith('point-evidence-differs'));

    expect(point).toBeDefined();
    expect(point?.detail).toContain('AB12CDF');
    for (const forbidden of [/invalid/i, /ground of appeal/i, /will succeed/i, /guaranteed/i]) {
      expect(point?.detail).not.toMatch(forbidden);
      expect(point?.headline).not.toMatch(forbidden);
    }
  });

  it('never hides the contradiction to make the pack read better', () => {
    const built = wrongVrm();
    // The same fact appears in both sections on purpose: it is the strongest
    // thing the record contains and the thing most likely to defeat them.
    expect(built.evidence.items[0]?.standing).toBe('CONFLICTING');
    expect(built.weaknesses.some((w) => w.id.startsWith('weak-conflict-'))).toBe(true);
  });

  it('always produces a weaknesses section', () => {
    // Mandatory. A pack with a clean bill of health is the one that would get
    // somebody hurt.
    expect(pack().weaknesses.length).toBeGreaterThan(0);
    expect(wrongVrm().weaknesses.length).toBeGreaterThan(0);
    expect(
      pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED')] }).weaknesses.length,
    ).toBeGreaterThan(0);
  });

  it('says the authority’s photographs are missing', () => {
    expect(pack().weaknesses.some((w) => w.id === 'weak-no-authority-photographs')).toBe(true);
  });
});

describe('F. the checklist is case-specific', () => {
  it('sorts what is held from what is wanted from what does not apply', () => {
    const built = pack({ evidenceItems: [evidenceItem('PCN_IMAGE', 'VERIFIED')] });
    const standings = new Map(built.checklist.map((e) => [e.type, e.standing]));

    expect(standings.get('PCN_IMAGE')).toBe('ALREADY_HAVE');
    expect(standings.get('COUNCIL_PHOTOGRAPHS')).toBe('RECOMMENDED');
    // Every evidence type is accounted for, so nothing looks forgotten.
    expect(built.checklist.some((e) => e.standing === 'NOT_RELEVANT')).toBe(true);
  });
});

describe('G. the paid product gets no weaker a deadline standard', () => {
  it('carries the printed date and refuses the calculated ones', () => {
    const built = pack();

    // Every timing rule in the store is PENDING_LEGAL_REVIEW, so the only date
    // that survives is the one the user read off their own notice.
    expect(built.dates.deadlines.map((d) => d.date)).toContain('2026-01-18');
    for (const deadline of built.dates.deadlines) {
      expect(deadline.source).toBe('PRINTED_ON_NOTICE');
    }
    /*
     * Refusals come in two kinds — a rule awaiting review, and a trigger date
     * the user never confirmed — so not every entry carries the same reason.
     * What matters is that the awaiting-review refusal is present and that no
     * calculated date got through, which the loop above already establishes.
     */
    expect(built.dates.refused.length).toBeGreaterThan(0);
    expect(built.dates.refused.some((r) => r.reason === 'RULE_AWAITING_REVIEW')).toBe(true);
    expect(built.dates.deadlines.some((d) => d.source === 'CALCULATED_BY_PCNWATCH')).toBe(false);
  });

  it('lets no unreviewed date into the drafting material', () => {
    const built = pack();
    const refusedLabels = built.dates.refused.map((r) => r.label);
    const material = establishedFacts(built).map((f) => f.text).join(' ');
    for (const label of refusedLabels) {
      expect(material).not.toContain(label);
    }
  });
});

describe('legal position: what the pack will not claim', () => {
  it('states plainly that it cannot establish a statutory ground', () => {
    /*
     * Every statutory ground, contravention and procedure record in the store
     * is PENDING_LEGAL_REVIEW. The pack says so instead of paraphrasing the
     * Traffic Management Act from a model's memory of it.
     */
    const built = pack();
    expect(built.legalPosition.canStateGrounds).toBe(false);
    expect(built.legalPosition.explanation).toMatch(/facts, not legal grounds/i);
    expect(built.legalPosition.explanation).toMatch(/will not paraphrase/i);
  });

  it('offers the drafting layer no unreviewed reference to cite', () => {
    const built = pack();
    expect(built.permittedReferences.referenceKeys).toEqual([]);
  });

  it('names a ground the user asked about that we cannot support', () => {
    const built = pack({ assertedGroundKeys: ['GROUND-CONTRAVENTION_DID_NOT_OCCUR'] });
    expect(built.legalPosition.unreviewedGrounds).toContain('GROUND-CONTRAVENTION_DID_NOT_OCCUR');
  });
});

describe('evidence basis wording is unchanged by the paid product', () => {
  it('carries the assessment’s own basis and explanation', () => {
    const built = pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED')] });
    const view = buildCaseView(
      caseRecord({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED')] }),
      TODAY,
    );

    expect(built.evidenceBasis).toBe(view.assessment.basis);
    expect(built.evidenceBasisExplanation).toBe(view.assessment.basisExplanation);
    // Evidential support, never a chance of winning.
    for (const forbidden of [/%/, /likely to win/i, /strong appeal/i, /guaranteed/i, /chance/i]) {
      expect(built.evidenceBasisExplanation).not.toMatch(forbidden);
    }
  });
});

describe('the drafting material is closed', () => {
  it('permits only what the pack established', () => {
    const built = pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED')] });
    const permitted = built.permittedReferences;

    expect(permitted.verifiedCaseFields).toContain('pcnNumber');
    expect(permitted.confirmedAssertions).toEqual(['PAYMENT_MADE', 'PAYMENT_BY_APP']);
    expect(permitted.evidenceRefs).toHaveLength(1);

    // Nothing in the drafting material references anything outside that set.
    const allowed = new Set([
      ...permitted.verifiedCaseFields,
      ...permitted.confirmedAssertions,
      ...permitted.evidenceRefs,
    ]);
    for (const fact of establishedFacts(built)) {
      expect(allowed.has(fact.reference), `${fact.reference} is not a permitted handle`).toBe(true);
    }
  });

  it('offers no evidence handle for a document nobody has checked', () => {
    const built = pack({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'UPLOADED')] });
    expect(built.permittedReferences.evidenceRefs).toEqual([]);
  });
});

describe('staleness', () => {
  it('is not stale when nothing has moved', () => {
    const record = caseRecord();
    expect(checkStaleness(fingerprintCase(record), fingerprintCase(record)).stale).toBe(false);
  });

  it('notices evidence arriving after the pack was built', () => {
    const before = fingerprintCase(caseRecord());
    const after = fingerprintCase(
      caseRecord({ evidenceItems: [evidenceItem('COUNCIL_PHOTOGRAPHS', 'VERIFIED')] }),
    );
    const staleness = checkStaleness(after, before);

    expect(staleness.stale).toBe(true);
    expect(staleness.stale && staleness.evidenceChanged).toBe(true);
    expect(staleness.stale && staleness.caseChanged).toBe(false);
    expect(staleness.stale && staleness.message).toMatch(/evidence has changed/i);
  });

  it('notices an evidence item being confirmed, not merely added', () => {
    /*
     * The same row, moving from read to confirmed. The id is pinned because the
     * fixture derives one from the status, and without pinning it this test
     * passed on the id changing rather than on the confirmation — it survived
     * the fingerprint being reduced to ids alone, which is the bug it exists to
     * catch.
     */
    const id = 'evidence-fixed-id';
    const uploaded = fingerprintCase(
      caseRecord({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'ANALYSED', { id })] }),
    );
    const verified = fingerprintCase(
      caseRecord({ evidenceItems: [evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', { id })] }),
    );
    expect(checkStaleness(verified, uploaded).stale).toBe(true);
  });

  it('notices a reading being corrected on an item already confirmed', () => {
    // Same row, same status, different registration. A fingerprint over ids or
    // statuses alone would call this unchanged and present a pack asserting the
    // old value as current.
    const id = 'evidence-fixed-id';
    const before = fingerprintCase(
      caseRecord({
        evidenceItems: [
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
            id,
            verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' }],
          }),
        ],
      }),
    );
    const after = fingerprintCase(
      caseRecord({
        evidenceItems: [
          evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
            id,
            verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' }],
          }),
        ],
      }),
    );
    expect(checkStaleness(after, before).stale).toBe(true);
  });

  it('notices a case fact changing', () => {
    const before = fingerprintCase(caseRecord());
    const after = fingerprintCase(caseRecord({ incidentDate: '2026-01-05' }));
    const staleness = checkStaleness(after, before);

    expect(staleness.stale && staleness.caseChanged).toBe(true);
    expect(staleness.stale && staleness.evidenceChanged).toBe(false);
  });

  it('does not go stale on the order rows came back in', () => {
    // An unsorted fingerprint would flag packs at random, and a warning that
    // fires when nothing happened is one nobody reads the time it matters.
    const a = caseRecord({
      confirmedAssertions: [
        { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
        { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
      ],
    });
    const b = caseRecord({
      confirmedAssertions: [
        { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
        { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
      ],
    });
    expect(fingerprintCase(a).caseFingerprint).toBe(fingerprintCase(b).caseFingerprint);
  });
});
