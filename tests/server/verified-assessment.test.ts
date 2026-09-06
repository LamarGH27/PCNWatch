import { describe, expect, it } from 'vitest';
import { assessVerifiedNotice, maskPcnNumber, type VerifiedFacts } from '@/server/cases/assess-verified';
import { stageForNoticeType, isDisplayableStage } from '@/core/case/stage-from-notice';
import { knownContraventionCodes } from '@/core/reference/store';
import { SYNTHETIC_PCN } from '../fixtures/pcn/synthetic-pcn';

/**
 * What a user gets after confirming their notice.
 *
 * The journey used to end on "Case saved. Return home" — a screen that saved
 * nothing and led nowhere. These cover what replaced it, and in particular the
 * boundaries: no invented law, no calculated date presented as printed, no
 * evidence basis that reads as a prediction, and nothing unconfirmed reaching
 * the engines.
 */

function facts(over: Partial<VerifiedFacts> = {}): VerifiedFacts {
  return {
    noticeType: 'PCN_POSTAL',
    authorityName: SYNTHETIC_PCN.authorityName,
    pcnNumber: SYNTHETIC_PCN.pcnNumber,
    vehicleRegistration: SYNTHETIC_PCN.vehicleRegistration,
    contraventionCode: SYNTHETIC_PCN.contraventionCode,
    contraventionDescription: SYNTHETIC_PCN.contraventionDescription,
    incidentDate: SYNTHETIC_PCN.incidentDate,
    incidentTime: SYNTHETIC_PCN.incidentTime,
    issueDate: SYNTHETIC_PCN.issueDate,
    location: SYNTHETIC_PCN.location,
    fullAmountPence: SYNTHETIC_PCN.fullAmountPence,
    discountedAmountPence: SYNTHETIC_PCN.discountedAmountPence,
    ...over,
  };
}

describe('a verified council PCN produces an assessment', () => {
  it('is supported and carries an evidence basis', () => {
    const result = assessVerifiedNotice(facts());
    expect(result.supported).toBe(true);
    expect([
      'STRONG_EVIDENCE_BASIS',
      'MODERATE_EVIDENCE_BASIS',
      'WEAK_EVIDENCE_BASIS',
      'INSUFFICIENT_INFORMATION',
    ]).toContain(result.assessment.basis);
  });

  it('places the case in the process from the notice type', () => {
    expect(assessVerifiedNotice(facts()).stage).toBe('NEW');
    expect(assessVerifiedNotice(facts({ noticeType: 'NOTICE_TO_OWNER' })).stage).toBe(
      'NOTICE_TO_OWNER',
    );
  });

  it('shows no stage when the notice does not establish one', () => {
    const result = assessVerifiedNotice(facts({ noticeType: 'UNKNOWN' }));
    expect(result.stageIsKnown).toBe(false);
    expect(isDisplayableStage(result.stage)).toBe(false);
  });

  it('surfaces what is missing rather than filling it in', () => {
    const result = assessVerifiedNotice(facts());
    expect(result.assessment.missingInformation.length).toBeGreaterThan(0);
  });
});

describe('the contravention explanation comes from approved reference data', () => {
  it('uses the approved summary for a code we hold', () => {
    const known = knownContraventionCodes()[0];
    expect(known, 'the reference store must hold at least one code').toBeTruthy();

    const result = assessVerifiedNotice(facts({ contraventionCode: known }));
    expect(result.contravention.meaning).toBeTruthy();
    expect(result.contravention.citation).not.toBeNull();
    expect(result.contravention.citation?.sourceName).toBeTruthy();
  });

  it('reports no meaning for a code we do not hold, rather than inventing one', () => {
    // 87 is not in the approved store. 99 is — picking it here would have
    // tested nothing.
    const result = assessVerifiedNotice(facts({ contraventionCode: '87' }));
    expect(result.contravention.meaning).toBeNull();
    expect(result.contravention.citation).toBeNull();
  });

  it('keeps the notice wording separate from the approved meaning', () => {
    const result = assessVerifiedNotice(
      facts({ contraventionDescription: 'Parked where you should not have' }),
    );
    // The notice's own words are carried, but never as the legal meaning.
    expect(result.contravention.asPrintedOnNotice).toBe('Parked where you should not have');
    expect(result.contravention.meaning).not.toBe('Parked where you should not have');
  });
});

describe('deadlines', () => {
  it('labels a printed deadline as printed, never as calculated', () => {
    const result = assessVerifiedNotice(
      facts({ discountDeadlinePrinted: '2026-08-28', representationDeadlinePrinted: '2026-09-11' }),
    );
    expect(result.printedDeadlines).toHaveLength(2);
    for (const deadline of result.printedDeadlines) {
      expect(deadline.source).toBe('PRINTED_ON_NOTICE');
    }
    // A printed date is reproduced exactly, never recomputed.
    expect(result.printedDeadlines[0]!.date).toBe('2026-08-28');
  });

  it('labels a worked-out deadline as ours, with the date it keys off', () => {
    const result = assessVerifiedNotice(facts({ issueDate: '2026-08-14' }));
    expect(result.calculatedDeadlines.length).toBeGreaterThan(0);
    for (const deadline of result.calculatedDeadlines) {
      expect(deadline.source).toBe('CALCULATED_BY_PCNWATCH');
      expect(deadline.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(deadline.basis.length).toBeGreaterThan(0);
    }
  });

  it('never mixes the two', () => {
    const result = assessVerifiedNotice(
      facts({ issueDate: '2026-08-14', discountDeadlinePrinted: '2026-08-28' }),
    );
    const printed = new Set(result.printedDeadlines.map((d) => d.source));
    const calculated = new Set(result.calculatedDeadlines.map((d) => d.source));
    expect(printed).toEqual(new Set(['PRINTED_ON_NOTICE']));
    expect(calculated).toEqual(new Set(['CALCULATED_BY_PCNWATCH']));
  });

  it('refuses rather than estimating when the trigger date is unconfirmed', () => {
    const result = assessVerifiedNotice(facts({ issueDate: undefined }));
    expect(result.calculatedDeadlines).toEqual([]);
    expect(result.refusedDeadlines.length).toBeGreaterThan(0);
    for (const refusal of result.refusedDeadlines) {
      expect(refusal.message.length).toBeGreaterThan(0);
    }
  });

  it('is deterministic', () => {
    const input = facts();
    expect(assessVerifiedNotice(input)).toEqual(assessVerifiedNotice(input));
  });
});

describe('unconfirmed values never reach the engines', () => {
  it('treats an absent fact as not established, not as a default', () => {
    // A user who marked the date unknown must not get a deadline anyway.
    const withDate = assessVerifiedNotice(facts({ issueDate: '2026-08-14' }));
    const without = assessVerifiedNotice(facts({ issueDate: undefined }));

    expect(withDate.calculatedDeadlines.length).toBeGreaterThan(0);
    expect(without.calculatedDeadlines).toHaveLength(0);
  });

  it('reports an unconfirmed amount as absent rather than zero', () => {
    const result = assessVerifiedNotice(facts({ fullAmountPence: undefined }));
    expect(result.amountSummary.full).toBeNull();
  });
});

describe('private parking charges stay out of council logic', () => {
  it('is unsupported and explained', () => {
    const result = assessVerifiedNotice(facts({ noticeType: 'PRIVATE_PARKING_CHARGE' }));
    expect(result.supported).toBe(false);
    expect(result.unsupportedMessage).toBeTruthy();
    expect(result.assessment.outOfScope).toBe(true);
  });

  it('produces no council deadlines at all', () => {
    const result = assessVerifiedNotice(
      facts({ noticeType: 'PRIVATE_PARKING_CHARGE', issueDate: '2026-08-14' }),
    );
    expect(result.calculatedDeadlines).toHaveLength(0);
    expect(result.stageIsKnown).toBe(false);
  });
});

describe('the evidence basis is never a prediction', () => {
  it('says nothing about odds, chances or winning', () => {
    for (const noticeType of ['PCN_POSTAL', 'PCN_ON_STREET', 'NOTICE_TO_OWNER'] as const) {
      const result = assessVerifiedNotice(facts({ noticeType }));
      const wording = `${result.assessment.basisExplanation}`.toLowerCase();
      for (const forbidden of [
        'chance',
        'likely to win',
        'you will win',
        'probability',
        'odds',
        '% success',
        'guarantee',
      ]) {
        expect(wording, `basis explanation must not mention "${forbidden}"`).not.toContain(forbidden);
      }
    }
  });

  it('describes weak evidence without describing a poor outcome', () => {
    // Almost nothing confirmed: the basis must speak about evidence, not results.
    const bare = assessVerifiedNotice({ noticeType: 'PCN_POSTAL' });
    expect(bare.assessment.basisExplanation.toLowerCase()).not.toMatch(/win|lose|chance|unlikely/);
  });
});

describe('displaying the PCN number', () => {
  it('masks the middle so it is recognisable but not reproduced', () => {
    const masked = maskPcnNumber('TB99887766');
    expect(masked.startsWith('TB')).toBe(true);
    expect(masked.endsWith('66')).toBe(true);
    expect(masked).not.toContain('998877');
  });

  it('leaves a very short reference alone rather than mangling it', () => {
    expect(maskPcnNumber('AB12')).toBe('AB12');
  });
});

describe('stage mapping', () => {
  it('never invents a stage the model does not define', () => {
    for (const noticeType of ['CHARGE_CERTIFICATE', 'ORDER_FOR_RECOVERY'] as const) {
      expect(stageForNoticeType(noticeType)).toBe('UNKNOWN_STAGE');
    }
  });
});
