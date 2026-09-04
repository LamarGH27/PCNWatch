import { describe, expect, it } from 'vitest';
import { assessCase, permittedCitationKeys, type AssessmentInput } from '@/core/assessment/engine';
import { buildEvidenceChecklist } from '@/core/evidence/checklist';
import { allCitationsExist } from '@/core/reference/store';

const verifiedAll = {
  pcnNumber: true,
  contraventionCode: true,
  incidentDate: true,
  location: true,
  amount: true,
};

function baseInput(overrides: Partial<AssessmentInput> = {}): AssessmentInput {
  return {
    contraventionCode: '12',
    proceduralStage: 'FORMAL_REPRESENTATION',
    noticeCategory: 'LOCAL_AUTHORITY_PCN',
    assertedGroundKeys: [],
    evidenceProvided: {},
    userNarrativeProvided: true,
    verifiedFields: verifiedAll,
    ...overrides,
  };
}

describe('assessment engine', () => {
  it('never emits a numeric win probability', () => {
    const assessment = assessCase(
      baseInput({
        assertedGroundKeys: ['GROUND-CONTRAVENTION_DID_NOT_OCCUR'],
        evidenceProvided: { PERMIT: 1, PCN_IMAGE: 1 },
      }),
    );
    const serialised = JSON.stringify(assessment);
    expect(serialised).not.toMatch(/\d+%\s*(chance|likelihood|probability)/i);
    expect(assessment.basis).toMatch(/EVIDENCE_BASIS|INSUFFICIENT_INFORMATION/);
  });

  it('reports INSUFFICIENT_INFORMATION when key fields are unverified', () => {
    const assessment = assessCase(
      baseInput({ verifiedFields: { ...verifiedAll, incidentDate: false } }),
    );
    expect(assessment.basis).toBe('INSUFFICIENT_INFORMATION');
    expect(assessment.missingInformation.length).toBeGreaterThan(0);
  });

  it('reports INSUFFICIENT_INFORMATION when the user has told us nothing', () => {
    const assessment = assessCase(baseInput({ userNarrativeProvided: false }));
    expect(assessment.basis).toBe('INSUFFICIENT_INFORMATION');
  });

  it('reports a WEAK basis when grounds are asserted with no supporting evidence', () => {
    const assessment = assessCase(
      baseInput({ assertedGroundKeys: ['GROUND-ALREADY_PAID'], evidenceProvided: {} }),
    );
    expect(assessment.basis).toBe('WEAK_EVIDENCE_BASIS');
  });

  it('reports a STRONG basis only when essential evidence is complete', () => {
    const weak = assessCase(
      baseInput({
        assertedGroundKeys: ['GROUND-ALREADY_PAID'],
        evidenceProvided: { PAYMENT_RECEIPT: 1, CORRESPONDENCE: 1 },
      }),
    );
    // PCN_IMAGE is an essential baseline item, so this cannot be STRONG yet.
    expect(weak.basis).not.toBe('STRONG_EVIDENCE_BASIS');

    const strong = assessCase(
      baseInput({
        assertedGroundKeys: ['GROUND-ALREADY_PAID'],
        evidenceProvided: { PAYMENT_RECEIPT: 1, CORRESPONDENCE: 1, PCN_IMAGE: 1 },
      }),
    );
    expect(strong.basis).toBe('STRONG_EVIDENCE_BASIS');
  });

  it('refuses to assess a private parking charge under council rules', () => {
    const assessment = assessCase(baseInput({ noticeCategory: 'PRIVATE_PARKING_CHARGE' }));
    expect(assessment.outOfScope).toBe(true);
    expect(assessment.findings).toHaveLength(0);
    expect(assessment.outOfScopeMessage).toContain('local-authority PCNs');
  });

  it('refuses to assess a notice whose type is unconfirmed', () => {
    const assessment = assessCase(baseInput({ noticeCategory: 'UNKNOWN' }));
    expect(assessment.outOfScope).toBe(true);
  });

  it('flags an unknown contravention code instead of inventing one', () => {
    const assessment = assessCase(baseInput({ contraventionCode: '97' }));
    expect(assessment.missingInformation.some((m) => m.includes('97'))).toBe(true);
    expect(assessment.findingsByCategory.FACTUAL_DISPUTE.some((f) => f.id.includes('97'))).toBe(false);
  });

  it('flags a contravention suffix it cannot interpret', () => {
    const assessment = assessCase(baseInput({ contraventionSuffix: 'a' }));
    expect(assessment.missingInformation.some((m) => m.includes('suffix'))).toBe(true);
  });

  it('only ever cites references that exist in the approved store', () => {
    const assessment = assessCase(
      baseInput({
        assertedGroundKeys: ['GROUND-CONTRAVENTION_DID_NOT_OCCUR', 'GROUND-PROCEDURAL_IMPROPRIETY'],
        evidenceProvided: { PCN_IMAGE: 1 },
      }),
    );
    expect(allCitationsExist(permittedCitationKeys(assessment))).toBe(true);
    expect(assessment.citations.length).toBeGreaterThan(0);
  });

  it('ignores a ground key that does not exist rather than fabricating a finding', () => {
    const assessment = assessCase(baseInput({ assertedGroundKeys: ['GROUND-DOES-NOT-EXIST'] }));
    expect(assessment.findingsByCategory.STATUTORY_GROUND).toHaveLength(0);
    expect(assessment.missingInformation.some((m) => m.includes('GROUND-DOES-NOT-EXIST'))).toBe(true);
  });

  it('notes when a ground is not available at the current stage', () => {
    const assessment = assessCase(
      baseInput({ proceduralStage: 'NEW', assertedGroundKeys: ['GROUND-NOT_THE_OWNER'] }),
    );
    const finding = assessment.findingsByCategory.STATUTORY_GROUND[0];
    expect(finding?.whyItMayMatter).toContain('not normally available');
  });

  it('does not check the amount when the expected band is unknown', () => {
    const assessment = assessCase(
      baseInput({
        amountCheck: { amountDemandedPence: 13000, expectedFullPence: null, expectedDiscountedPence: null },
      }),
    );
    expect(assessment.findingsByCategory.PROCEDURAL_ISSUE).toHaveLength(0);
    expect(assessment.missingInformation.some((m) => m.includes('penalty band'))).toBe(true);
  });

  it('raises a procedural finding when the amount exceeds the known band', () => {
    const assessment = assessCase(
      baseInput({
        amountCheck: { amountDemandedPence: 20000, expectedFullPence: 13000, expectedDiscountedPence: 6500 },
      }),
    );
    expect(assessment.findingsByCategory.PROCEDURAL_ISSUE).toHaveLength(1);
  });

  it('is deterministic', () => {
    const input = baseInput({
      assertedGroundKeys: ['GROUND-ALREADY_PAID'],
      evidenceProvided: { PAYMENT_RECEIPT: 1 },
    });
    expect(JSON.stringify(assessCase(input))).toEqual(JSON.stringify(assessCase(input)));
  });
});

describe('evidence checklist', () => {
  it('varies by contravention', () => {
    const blueBadge = buildEvidenceChecklist({ contraventionCode: '40' });
    const suspended = buildEvidenceChecklist({ contraventionCode: '21' });
    expect(blueBadge.items.map((i) => i.type)).toContain('BLUE_BADGE');
    expect(suspended.items.map((i) => i.type)).not.toContain('BLUE_BADGE');
  });

  it('escalates evidence to essential when a ground depends on it', () => {
    const checklist = buildEvidenceChecklist({
      contraventionCode: '12',
      assertedGroundKeys: ['GROUND-ALREADY_PAID'],
    });
    const receipt = checklist.items.find((i) => i.type === 'PAYMENT_RECEIPT');
    expect(receipt?.importance).toBe('ESSENTIAL');
  });

  it('tracks what is provided and what is still missing', () => {
    const checklist = buildEvidenceChecklist({
      contraventionCode: '12',
      provided: { PCN_IMAGE: 2 },
    });
    expect(checklist.providedCount).toBe(1);
    expect(checklist.missingEssential).not.toContain('PCN_IMAGE');
    expect(checklist.items.find((i) => i.type === 'PCN_IMAGE')?.itemCount).toBe(2);
  });

  it('falls back to the baseline for an unknown contravention without inventing requirements', () => {
    const checklist = buildEvidenceChecklist({ contraventionCode: '97' });
    expect(checklist.items.map((i) => i.type).sort()).toEqual(['COUNCIL_PHOTOGRAPHS', 'PCN_IMAGE']);
  });

  it('gives every item capture guidance', () => {
    for (const item of buildEvidenceChecklist({ contraventionCode: '01' }).items) {
      expect(item.definition.howToCapture.length).toBeGreaterThan(10);
      expect(item.definition.whyItMatters.length).toBeGreaterThan(10);
    }
  });
});
