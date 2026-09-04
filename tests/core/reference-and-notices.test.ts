import { describe, expect, it } from 'vitest';
import {
  allCitationsExist,
  allReferences,
  contraventionSuffix,
  getContravention,
  indexableContraventions,
  isPubliclyIndexable,
  knownContraventionCodes,
  normaliseContraventionCode,
  unknownCitations,
} from '@/core/reference/store';
import { classifyNotice, PRIVATE_PARKING_MESSAGE } from '@/core/notices/classify-notice';
import { canTransition, requestTransition } from '@/core/case/state-machine';

describe('reference store', () => {
  it('rejects nothing at load time — every record carries a real source', () => {
    for (const record of allReferences()) {
      expect(record.sourceName.length).toBeGreaterThan(0);
      expect(record.sourceLocation.length).toBeGreaterThan(0);
      expect(record.summary.length).toBeGreaterThan(0);
    }
  });

  it('never marks a record REVIEWED without a review date', () => {
    for (const record of allReferences()) {
      if (record.reviewStatus === 'REVIEWED') expect(record.reviewedAt).toBeTruthy();
    }
  });

  it('normalises contravention codes and preserves suffixes separately', () => {
    expect(normaliseContraventionCode('1')).toBe('01');
    expect(normaliseContraventionCode('01')).toBe('01');
    expect(normaliseContraventionCode(' 12 ')).toBe('12');
    expect(normaliseContraventionCode('01a')).toBe('01');
    expect(contraventionSuffix('01a')).toBe('a');
    expect(contraventionSuffix('01')).toBeNull();
  });

  it('returns undefined for a code it does not hold rather than inventing one', () => {
    expect(getContravention('97')).toBeUndefined();
    expect(getContravention('01')).toBeDefined();
  });

  it('keeps unreviewed reference pages out of the indexable set', () => {
    for (const record of indexableContraventions()) {
      expect(isPubliclyIndexable(record)).toBe(true);
      expect(record.reviewStatus).toBe('REVIEWED');
    }
  });

  it('detects citations that do not exist in the store', () => {
    expect(allCitationsExist(['CONTRAVENTION-01'])).toBe(true);
    expect(allCitationsExist(['CONTRAVENTION-01', 'MADE-UP-CASE-2019'])).toBe(false);
    expect(unknownCitations(['CONTRAVENTION-01', 'MADE-UP-CASE-2019'])).toEqual(['MADE-UP-CASE-2019']);
  });

  it('holds at least the codes it claims to know', () => {
    const codes = knownContraventionCodes();
    expect(codes).toContain('01');
    expect(codes).toContain('12');
    expect(codes).toContain('21');
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('notice classification', () => {
  it('identifies a local-authority PCN', () => {
    const result = classifyNotice(
      'PENALTY CHARGE NOTICE issued by the London Borough of Camden under the Traffic Management Act 2004. Contravention code 01.',
    );
    expect(result.category).toBe('LOCAL_AUTHORITY_PCN');
    expect(result.outOfScopeMessage).toBeNull();
  });

  it('identifies a private parking charge and refuses to apply council rules', () => {
    const result = classifyNotice(
      'PARKING CHARGE NOTICE. You breached the terms and conditions of parking on this private land. ' +
        'Issued under the Protection of Freedoms Act 2012 Schedule 4. Appeals to POPLA.',
    );
    expect(result.category).toBe('PRIVATE_PARKING_CHARGE');
    expect(result.noticeType).toBe('PRIVATE_PARKING_CHARGE');
    expect(result.outOfScopeMessage).toBe(PRIVATE_PARKING_MESSAGE);
  });

  it('returns UNKNOWN rather than guessing when signals are absent', () => {
    const result = classifyNotice('Dear customer, your vehicle was seen at this location on Tuesday.');
    expect(result.category).toBe('UNKNOWN');
    expect(result.confidence).toBe(0);
  });

  it('returns UNKNOWN when the document carries conflicting signals', () => {
    const result = classifyNotice('Penalty Charge Notice. Parking Charge Notice. Breach of contract.');
    expect(result.category).toBe('UNKNOWN');
    expect(result.noticeType).toBe('UNKNOWN');
  });

  it('recognises the specific statutory document type', () => {
    const base =
      'London Borough of Camden. Traffic Management Act 2004. Notice to Owner. Charge Certificate may follow.';
    expect(classifyNotice(base).noticeType).toBe('CHARGE_CERTIFICATE');
    expect(
      classifyNotice(
        'London Borough of Camden Traffic Management Act 2004 NOTICE OF REJECTION of representations. London Tribunals.',
      ).noticeType,
    ).toBe('NOTICE_OF_REJECTION');
  });
});

describe('case state machine', () => {
  it('permits only defined transitions', () => {
    expect(canTransition('NEW', 'INFORMAL_CHALLENGE')).toBe(true);
    expect(canTransition('NEW', 'TRIBUNAL_APPEAL')).toBe(false);
    expect(canTransition('NOTICE_TO_OWNER', 'FORMAL_REPRESENTATION')).toBe(true);
  });

  it('never moves a closed case', () => {
    const outcome = requestTransition({ from: 'CLOSED_PAID', to: 'NEW', actor: 'USER' });
    expect(outcome.allowed).toBe(false);
    expect(outcome.stage).toBe('CLOSED_PAID');
  });

  it('refuses a document-driven transition the user has not verified', () => {
    const outcome = requestTransition({
      from: 'FORMAL_REPRESENTATION',
      to: 'NOTICE_OF_REJECTION',
      actor: 'DOCUMENT_VERIFIED',
      confidence: 0.99,
      userVerified: false,
    });
    expect(outcome.allowed).toBe(false);
    expect(outcome.stage).toBe('FORMAL_REPRESENTATION');
  });

  it('refuses a low-confidence document-driven transition even when verified', () => {
    const outcome = requestTransition({
      from: 'FORMAL_REPRESENTATION',
      to: 'NOTICE_OF_REJECTION',
      actor: 'DOCUMENT_VERIFIED',
      confidence: 0.4,
      userVerified: true,
    });
    expect(outcome.allowed).toBe(false);
  });

  it('allows a confident, verified document-driven transition', () => {
    const outcome = requestTransition({
      from: 'FORMAL_REPRESENTATION',
      to: 'NOTICE_OF_REJECTION',
      actor: 'DOCUMENT_VERIFIED',
      confidence: 0.95,
      userVerified: true,
    });
    expect(outcome).toEqual({ allowed: true, stage: 'NOTICE_OF_REJECTION' });
  });

  it('lets a user rescue a case from UNKNOWN_STAGE', () => {
    expect(requestTransition({ from: 'UNKNOWN_STAGE', to: 'NOTICE_TO_OWNER', actor: 'USER' }).allowed).toBe(
      true,
    );
  });
});
