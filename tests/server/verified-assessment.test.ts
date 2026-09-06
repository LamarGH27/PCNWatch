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

describe('who issued the notice decides the category, not who we hold data for', () => {
  /**
   * A real Westminster PCN was told it was an unidentifiable document.
   * Camden's enforcement history is the only borough data PCNWatch holds, and
   * that must never decide whether somebody else's notice is a notice.
   */

  it.each([
    ['London Borough of Camden', 'camden'],
    ['Westminster City Council', 'westminster'],
    ['Royal Borough of Kensington and Chelsea', 'kensington-chelsea'],
  ])('%s is a local-authority PCN', (authorityName, slug) => {
    const result = assessVerifiedNotice(facts({ authorityName }));
    expect(result.supported).toBe(true);
    expect(result.authority.recognised).toBe(true);
    expect(result.authority.slug).toBe(slug);
  });

  it.each([
    'Manchester City Council',
    'Birmingham City Council',
    'Cornwall Council',
    'Transport for London',
  ])('%s is a local-authority PCN even though we list no record for it', (authorityName) => {
    const result = assessVerifiedNotice(facts({ authorityName }));
    expect(result.supported).toBe(true);
    expect(result.authority.recognised).toBe(true);
    expect(result.assessment.outOfScope).toBe(false);
  });

  it('stays supported when the reader could not determine the notice type', () => {
    // The exact production failure: a genuine council PCN whose type read as
    // UNKNOWN was taken out of scope entirely.
    const result = assessVerifiedNotice(
      facts({ authorityName: 'Westminster City Council', noticeType: 'UNKNOWN' }),
    );
    expect(result.supported).toBe(true);
    expect(result.unsupportedMessage).toBeNull();
  });

  it('is still UNKNOWN when neither the authority nor the type identifies it', () => {
    const result = assessVerifiedNotice(
      facts({ authorityName: 'Acme Retail Park', noticeType: 'UNKNOWN' }),
    );
    expect(result.supported).toBe(false);
    expect(result.unsupportedMessage).toBeTruthy();
  });

  it.each(['ParkingEye Ltd', 'Total Parking Solutions Ltd', 'Britannia Parking Group Limited'])(
    '%s is a private operator, whatever the notice type says',
    (authorityName) => {
      const result = assessVerifiedNotice(facts({ authorityName, noticeType: 'PCN_POSTAL' }));
      expect(result.supported).toBe(false);
      expect(result.assessment.outOfScope).toBe(true);
      expect(result.calculatedDeadlines).toHaveLength(0);
    },
  );

  it('does not let a company called something borough-ish pass as a council', () => {
    const result = assessVerifiedNotice(facts({ authorityName: 'Borough Parking Ltd' }));
    expect(result.supported).toBe(false);
  });
});

describe('coverage is reported separately from support', () => {
  it('marks Camden as reviewed', () => {
    const result = assessVerifiedNotice(facts({ authorityName: 'London Borough of Camden' }));
    expect(result.authority.coverage).toBe('REVIEWED');
    expect(result.authority.coverageNote).toBeNull();
  });

  it('gives a non-Camden council a full assessment with a limited-coverage note', () => {
    const result = assessVerifiedNotice(
      facts({ authorityName: 'Westminster City Council', issueDate: '2026-08-14' }),
    );

    expect(result.supported).toBe(true);
    expect(result.authority.coverage).toBe('LIMITED');
    expect(result.authority.coverageNote).toBeTruthy();

    // Limited coverage must not mean a degraded assessment: the national rules
    // still run, and the deadlines are still worked out.
    expect(result.calculatedDeadlines.length).toBeGreaterThan(0);
    expect(result.assessment.basis).toBeTruthy();
    expect(result.stageIsKnown).toBe(true);
  });

  it('says what is missing without implying the notice is unsupported', () => {
    const note = assessVerifiedNotice(
      facts({ authorityName: 'Manchester City Council' }),
    ).authority.coverageNote!;
    expect(note.toLowerCase()).toContain('does not yet hold');
    for (const forbidden of ['unsupported', 'cannot help', 'outside what pcnwatch supports']) {
      expect(note.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('the verified facts carry the notice type from the read', () => {
  /**
   * The production bug. `collectVerifiedFacts` looked for the notice type
   * among the editable field views, and `FIELD_LABELS` has no entry for it —
   * so `.find()` returned undefined and every notice, of every authority,
   * reached the assessment as UNKNOWN. Camden's would have too; that journey
   * had never got past "Case saved" before.
   */

  it('is not one of the editable fields, so it cannot be read back from them', async () => {
    const { toFieldViews } = await import('@/server/cases/extraction');
    const field = (value: unknown) => ({ value, confidence: 0.95, sourceHint: null });
    const views = toFieldViews({
      authorityName: field('Westminster City Council'),
      pcnNumber: field('WM123'),
      vehicleRegistration: field('AB12 CDE'),
      noticeType: field('PCN_POSTAL'),
      contraventionCode: field('12'),
      contraventionDescription: field('x'),
      incidentDate: field('2026-08-11'),
      incidentTime: field('14:35'),
      issueDate: field('2026-08-14'),
      location: field('STRAND'),
      fullAmountPence: field(13_000),
      discountedAmountPence: field(6_500),
      discountDeadlinePrinted: field(null),
      representationDeadlinePrinted: field(null),
      proceduralStageIndicated: field('NEW'),
      unreadableRegions: [],
      overallLegibility: 'CLEAR',
    } as never);

    // This is the fact that broke it: no field view carries the notice type.
    expect(views.map((v) => v.key)).not.toContain('noticeType');
  });

  it('takes the notice type as an argument instead', async () => {
    const { collectVerifiedFacts } = await import('@/app/analyse/AnalyseFlow');
    const values = { authorityName: 'Westminster City Council', issueDate: '2026-08-14' };
    const confirmed = { authorityName: true, issueDate: true };

    const carried = collectVerifiedFacts(values, confirmed, 'PCN_POSTAL');
    expect(carried.noticeType).toBe('PCN_POSTAL');
    expect(assessVerifiedNotice(carried).supported).toBe(true);
  });

  it('omits a field the user edited but did not confirm', async () => {
    const { collectVerifiedFacts } = await import('@/app/analyse/AnalyseFlow');
    const collected = collectVerifiedFacts(
      { pcnNumber: 'WM123', issueDate: '2026-08-14' },
      { pcnNumber: true },
      'PCN_POSTAL',
    );
    expect(collected.pcnNumber).toBe('WM123');
    // Typed but never ticked, so it must not become a fact.
    expect(collected.issueDate).toBeUndefined();
  });
});
