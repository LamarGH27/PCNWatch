import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { buildDefencePack } from '@/server/defence/build';
import { establishedFacts } from '@/server/defence/generate';
import { challengeDraftInstruction } from '@/server/ai/prompts';
import { validateAiResponse } from '@/server/ai/validate';
import { MAX_MOST_USEFUL, packStatusFor } from '@/core/defence/types';
import { evidenceItem } from '../fixtures/evidence';

/**
 * The Westminster code 12 case, end to end.
 *
 * This is the case the Defence Pack was built for and the one it failed on. A
 * user photographed a notice, said they had paid by app and may have entered
 * the wrong registration, uploaded nothing, and received a pack that told them
 * the notice had not been provided, that the record supported nothing, that
 * they should gather six documents, and that no letter had been drafted.
 *
 * Every test here is one of those four failures, plus the thing that must not
 * change while they are fixed: no invented law.
 */

const TODAY = '2026-01-10';

/** The real shape: scanned notice, three confirmed assertions, no uploads. */
function westminster(overrides: Partial<CaseRecord> = {}): CaseRecord {
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
      { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
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
      issueDate: true,
      authorityName: true,
      vehicleRegistration: true,
    },
    evidenceItems: [],
    noticeSource: 'SCANNED',
    vehicleRegistration: 'AB12 CDE',
    incidentTime: '14:30',
    closedAt: null,
    ...overrides,
  };
}

function pack(overrides: Partial<CaseRecord> = {}) {
  const record = westminster(overrides);
  return buildDefencePack(record, buildCaseView(record, TODAY));
}

describe('the scanned notice counts as the notice', () => {
  it('does not ask for a notice the case was built from', () => {
    const built = pack();
    expect(built.evidence.sourceNoticeHeld).toBe(true);
    expect(built.weaknesses.map((w) => w.what).join(' ')).not.toMatch(
      /penalty charge notice has not been provided/i,
    );
  });

  it('shows the notice as already held, without a second upload', () => {
    const entry = pack().checklistSections.alreadyHave.find((e) => e.type === 'PCN_IMAGE');
    expect(entry).toBeDefined();
    expect(entry?.note).toMatch(/photographed this when you started/i);
  });

  it('still asks for it when the details were typed in', () => {
    const built = pack({ noticeSource: 'MANUAL' });
    expect(built.evidence.sourceNoticeHeld).toBe(false);
    expect(built.checklistSections.mostUseful.map((e) => e.type)).toContain('PCN_IMAGE');
  });

  it('does not let the source notice become supporting evidence', () => {
    /*
     * The notice is the thing being challenged, not something corroborating a
     * challenge. It satisfies the checklist requirement and must not appear as
     * evidence or lift the evidence basis.
     */
    const built = pack();
    expect(built.evidence.items).toEqual([]);
    expect(built.evidenceBasis).toBe('WEAK_EVIDENCE_BASIS');
  });
});

describe('the account is the case theory, and is labelled as such', () => {
  it('surfaces the confirmed assertions as factual points', () => {
    const points = pack().factualPoints;
    expect(points.length).toBeGreaterThan(0);
    expect(points.map((p) => p.headline).join(' ')).toMatch(/wrong registration/i);
  });

  it('labels every one of them as the user’s account', () => {
    for (const point of pack().factualPoints) {
      expect(point.basis).toBe('USER_ACCOUNT');
      expect(point.grounds.every((g) => g.source === 'CONFIRMED_USER_ASSERTION')).toBe(true);
    }
  });

  it('never calls an uncorroborated assertion established', () => {
    const built = pack();
    const prose = built.factualPoints.map((p) => `${p.headline} ${p.detail}`).join(' ');
    expect(prose).toMatch(/not corroborate|recollection rather than as established/i);
    for (const forbidden of [/proves/i, /establishes that/i, /it is a fact that/i]) {
      expect(prose).not.toMatch(forbidden);
    }
  });

  it('ranks an evidence-backed point above the account', () => {
    // Verified evidence stays stronger than a confirmed assertion. What
    // changed is that the account is shown at all, not what it outranks.
    const built = pack({
      evidenceItems: [
        evidenceItem('PARKING_APP_RECEIPT', 'VERIFIED', {
          verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' }],
        }),
      ],
    });
    expect(built.factualPoints[0]?.basis).toBe('VERIFIED_EVIDENCE');
    expect(built.factualPoints.some((p) => p.basis === 'USER_ACCOUNT')).toBe(true);
  });
});

describe('the checklist is three things, not six', () => {
  it('shows at most three under Most useful', () => {
    const sections = pack().checklistSections;
    expect(sections.mostUseful.length).toBeLessThanOrEqual(MAX_MOST_USEFUL);
    // And there really are more than three to choose from, so the cap is
    // doing something rather than being satisfied by the fixture.
    expect(sections.mostUseful.length + sections.other.length).toBeGreaterThan(MAX_MOST_USEFUL);
  });

  it('picks the three this case actually turns on', () => {
    const types = pack().checklistSections.mostUseful.map((e) => e.type);
    expect(types).toContain('PARKING_APP_RECEIPT');
    expect(types).toContain('COUNCIL_PHOTOGRAPHS');
  });

  it('keeps the rest rather than dropping it', () => {
    const sections = pack().checklistSections;
    const shown = [
      ...sections.alreadyHave,
      ...sections.mostUseful,
      ...sections.other,
      ...sections.notRelevant,
    ];
    expect(shown).toHaveLength(pack().checklist.length);
  });
});

describe('the challenge letter this case must be able to produce', () => {
  const grounding = (built = pack()) => ({
    permittedReferenceKeys: built.permittedReferences.referenceKeys,
    verifiedCaseFields: built.permittedReferences.verifiedCaseFields,
    permittedNarrativeRefs: built.permittedReferences.confirmedAssertions,
    availableEvidenceRefs: built.permittedReferences.evidenceRefs,
    reviewedLegalMaterial: built.legalPosition.canStateGrounds,
  });

  it('offers the model nothing it is not allowed to cite', () => {
    /*
     * The bug this catches: `vehicleRegistration` was added to the drafting
     * material while `caseSummary.vehicleRegistration` was ungated, so an
     * unverified registration could be offered as a fact the letter may
     * assert — and every draft citing it would be rejected.
     */
    /*
     * Run over a fully confirmed case AND a barely confirmed one. Against the
     * first alone this guard was vacuous: every field happened to be verified,
     * so an ungated value still landed inside the permitted set.
     */
    const cases = [
      pack(),
      pack({ verifiedFields: { pcnNumber: true, contraventionCode: true } }),
      pack({ verifiedFields: {} }),
    ];

    for (const built of cases) {
      const allowed = new Set([
        ...built.permittedReferences.verifiedCaseFields,
        ...built.permittedReferences.confirmedAssertions,
        ...built.permittedReferences.evidenceRefs,
      ]);
      for (const fact of establishedFacts(built)) {
        expect(allowed.has(fact.reference), `${fact.reference} is offered but not permitted`).toBe(
          true,
        );
      }
    }
  });

  it('gives the model the registration, which is the whole point of this case', () => {
    const material = establishedFacts(pack());
    expect(material.some((f) => f.reference === 'vehicleRegistration')).toBe(true);
  });

  it('withholds the registration when the user never confirmed it', () => {
    const built = pack({ verifiedFields: { pcnNumber: true, contraventionCode: true } });
    expect(establishedFacts(built).some((f) => f.reference === 'vehicleRegistration')).toBe(false);
  });

  it('never hands the model wording the validator forbids', () => {
    /*
     * The exact cause of the Preview failure. The instruction used to carry
     * `legalPosition.explanation`, which contains "the statutory grounds of
     * representation" — the precise phrase rejected when nothing is reviewed.
     * The input told the model, in forbidden words, not to use forbidden
     * words, and threw away every draft that repeated them.
     */
    const built = pack();
    const instruction = challengeDraftInstruction({
      caseSummary: { 'Issuing authority': built.caseSummary.authority },
      established: establishedFacts(built).map((f) => ({
        text: f.text,
        supportedBy: 'USER_NARRATIVE',
        reference: f.reference,
      })),
      weaknesses: built.weaknesses.map((w) => w.what),
      mayCiteLaw: built.legalPosition.canStateGrounds,
      citableReferenceKeys: built.permittedReferences.referenceKeys,
    });

    for (const forbidden of [
      /statutory ground(s)? (of|for) (appeal|representation)/i,
      /Traffic Management Act/i,
      /London Local Authorities Act/i,
      /\bthe Regulations\b/,
    ]) {
      expect(instruction, `the model is handed "${forbidden}"`).not.toMatch(forbidden);
    }
  });

  it('tells the model to cite nothing, rather than leaving it to guess', () => {
    const built = pack();
    const instruction = challengeDraftInstruction({
      caseSummary: {},
      established: [],
      weaknesses: [],
      mayCiteLaw: false,
      citableReferenceKeys: built.permittedReferences.referenceKeys,
    });
    expect(instruction).toMatch(/REFERENCES YOU MAY CITE/);
    expect(instruction).toMatch(/NONE\. Return citedReferenceKeys as an empty list\./);
  });

  it('accepts the letter this case should produce', () => {
    /*
     * A factual letter that argues the confirmed account and asks for
     * cancellation, with no legal ground stated. If this is rejected the
     * product cannot produce a Defence Pack for its own flagship case.
     */
    const built = pack();
    const draft = {
      subject: 'Challenge to penalty charge notice — Gloucester Place, 4 January 2026',
      body:
        'I am writing about the penalty charge notice issued on 4 January 2026 at Gloucester Place ' +
        'under contravention code 12, in the sum of £130.00, in respect of vehicle AB12 CDE. ' +
        'My recollection is that I paid for the parking session at the time using a mobile parking ' +
        'app. I believe I may have entered an incorrect vehicle registration when starting that ' +
        'session, which would explain why no payment was found against this vehicle. I have not yet ' +
        'been able to provide the app record, and I am happy to send it if that would assist. ' +
        'I would be grateful if you would reconsider this notice in light of the above and cancel it.',
      citedReferenceKeys: [],
      factualAssertions: [
        { assertion: 'The notice is dated 4 January 2026', supportedBy: 'VERIFIED_CASE_FIELD', reference: 'incidentDate' },
        { assertion: 'The registration on the notice is AB12 CDE', supportedBy: 'VERIFIED_CASE_FIELD', reference: 'vehicleRegistration' },
        { assertion: 'I paid using a parking app', supportedBy: 'USER_NARRATIVE', reference: 'PAYMENT_BY_APP' },
        { assertion: 'I may have entered the wrong registration', supportedBy: 'USER_NARRATIVE', reference: 'WRONG_VRM_POSSIBLE' },
      ],
      omittedBecauseUnsupported: [],
    };

    const result = validateAiResponse('CHALLENGE_DRAFTING', draft, grounding(built));
    expect(
      result.outcome,
      result.outcome !== 'ACCEPTED' ? result.errors.join(' | ') : '',
    ).toBe('ACCEPTED');
  });

  it('still rejects a letter that reaches for a legal ground to get there', () => {
    // The fix is better drafting inside the safe facts, never a looser guard.
    const built = pack();
    const draft = {
      subject: 'Challenge',
      body: 'I rely on the statutory ground of representation that the contravention did not occur.',
      citedReferenceKeys: [],
      factualAssertions: [
        { assertion: 'I paid using an app', supportedBy: 'USER_NARRATIVE', reference: 'PAYMENT_BY_APP' },
      ],
      omittedBecauseUnsupported: [],
    };
    expect(validateAiResponse('CHALLENGE_DRAFTING', draft, grounding(built)).outcome).toBe(
      'CITATION_REJECTED',
    );
  });
});

describe('a pack is only finished when its letter is', () => {
  it('is READY only with a letter', () => {
    expect(packStatusFor({ packBuilt: true, letterDrafted: true })).toBe('PACK_READY');
  });

  it('is PARTIAL when the sections built and the letter did not', () => {
    expect(packStatusFor({ packBuilt: true, letterDrafted: false })).toBe('PACK_PARTIAL');
  });

  it('is FAILED when nothing built', () => {
    expect(packStatusFor({ packBuilt: false, letterDrafted: false })).toBe(
      'PACK_GENERATION_FAILED',
    );
  });
});
