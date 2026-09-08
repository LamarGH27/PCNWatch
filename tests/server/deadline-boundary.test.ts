import { describe, expect, it } from 'vitest';
import { projectDeadlines } from '@/core/deadlines/projection';
import { DEADLINE_RULES } from '@/core/deadlines/rules';
import { calculateAllDeadlines } from '@/core/deadlines/calculate';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT } from '@/core/context/types';
import { POST } from '@/app/api/cases/assess/route';

/**
 * One boundary, every route.
 *
 * A resumed case displayed "Discounted amount deadline — 5 Jul 2026" and "Full
 * amount payable by — 19 Jul 2026" from rules marked PENDING_LEGAL_REVIEW, then
 * badged one "Passed" and told the user their discount period had expired. The
 * gate existed; it was inline in `assessVerifiedNotice` and covered that route
 * alone, while the saved-case view built its own from the raw engine.
 *
 * These cover the boundary itself and both routes through it, so a third route
 * cannot quietly reappear.
 */

const TODAY = '2026-09-07';

const WESTMINSTER: VerifiedFacts = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'City of Westminster',
  pcnNumber: 'WM77341902',
  contraventionCode: '12',
  incidentDate: '2026-06-11',
  issueDate: '2026-06-14',
  fullAmountPence: 13000,
  discountedAmountPence: 6500,
};

function caseRecord(over: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'case-1',
    pcnNumber: 'WM77341902',
    authorityName: 'City of Westminster',
    authoritySlug: null,
    noticeCategory: 'LOCAL_AUTHORITY_PCN',
    contraventionCode: '12',
    contraventionSuffix: null,
    incidentDate: '2026-06-11',
    issueDate: '2026-06-14',
    noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null,
    locationText: null,
    parkingLocationSlug: null,
    discountDeadlinePrinted: null,
    representationDeadlinePrinted: null,
    fullAmountPence: 13000,
    discountedAmountPence: 6500,
    proceduralStage: 'NEW',
    narrativeProvided: false,
    contextAnswers: [],
    confirmedAssertions: [],
    declaredEvidence: [],
    resolvedFacts: [],
    assertedGroundKeys: [],
    verifiedFields: { pcnNumber: true, contraventionCode: true, issueDate: true },
    evidenceItems: [],
    noticeSource: 'MANUAL',
    vehicleRegistration: null,
    incidentTime: null,
    closedAt: null,
    ...over,
  };
}

/** Dates the engine really does compute, so the tests cannot pass vacuously. */
function unreviewedDates(): string[] {
  return calculateAllDeadlines({
    pcnServedDate: WESTMINSTER.issueDate,
    verifiedDates: { pcnServedDate: true },
  })
    .filter((r) => r.calculated)
    .filter((r) => {
      const rule = DEADLINE_RULES.find((candidate) => candidate.deadlineType === r.deadlineType);
      return rule !== undefined && rule.reviewStatus !== 'REVIEWED';
    })
    .map((r) => (r as { calculatedDueDate: string }).calculatedDueDate);
}

describe('the premise', () => {
  it('the engine really does produce unreviewed dates for this case', () => {
    // Without this every assertion below could pass by there being nothing to
    // leak. This is the same notice that leaked in Preview.
    expect(unreviewedDates().length).toBeGreaterThan(0);
  });

  it('every timing rule is still awaiting review', () => {
    // The state of the world these tests assume. When a rule is signed off this
    // will fail, and the reviewed-rule tests below become the live ones.
    expect(DEADLINE_RULES.every((rule) => rule.reviewStatus !== 'REVIEWED')).toBe(true);
  });
});

describe('the projection is the only door', () => {
  it('returns no date from a rule awaiting review', () => {
    const projection = projectDeadlines({
      pcnServedDate: WESTMINSTER.issueDate,
      verifiedDates: { pcnServedDate: true },
      today: TODAY,
    });

    expect(projection.calculated).toEqual([]);
    expect(projection.refused.length).toBeGreaterThan(0);
    expect(projection.refused.some((r) => r.reason === 'RULE_AWAITING_REVIEW')).toBe(true);

    const serialised = JSON.stringify(projection);
    for (const date of unreviewedDates()) {
      expect(serialised, `${date} crossed the boundary`).not.toContain(date);
    }
  });

  it('will not say the discount period has passed from an unreviewed rule', () => {
    // Long after every calculated date has expired.
    const projection = projectDeadlines({
      pcnServedDate: WESTMINSTER.issueDate,
      verifiedDates: { pcnServedDate: true },
      today: '2027-06-01',
    });
    expect(projection.discountStatus).toBe('UNKNOWN');
    expect(projection.discountDecidedFrom).toBeNull();
  });

  it('does let a printed date decide the window, in both directions', () => {
    const open = projectDeadlines({
      printedDeadlines: { discountDeadline: '2026-09-28' },
      today: TODAY,
    });
    expect(open.discountStatus).toBe('OPEN');
    expect(open.discountDecidedFrom!.source).toBe('PRINTED_ON_NOTICE');

    const passed = projectDeadlines({
      printedDeadlines: { discountDeadline: '2026-06-28' },
      today: TODAY,
    });
    expect(passed.discountStatus).toBe('PASSED');
  });

  it('prefers the notice over anything it could work out', () => {
    const projection = projectDeadlines({
      pcnServedDate: WESTMINSTER.issueDate,
      verifiedDates: { pcnServedDate: true },
      printedDeadlines: { discountDeadline: '2026-09-28' },
      today: TODAY,
    });
    expect(projection.discountDecidedFrom!.source).toBe('PRINTED_ON_NOTICE');
    expect(projection.printed).toHaveLength(1);
  });

  it('calculates nothing where the rules do not apply', () => {
    const projection = projectDeadlines({
      pcnServedDate: WESTMINSTER.issueDate,
      verifiedDates: { pcnServedDate: true },
      calculationApplies: false,
      today: TODAY,
    });
    expect(projection.calculated).toEqual([]);
    expect(projection.refused).toEqual([]);
  });
});

describe('the fresh assessment', () => {
  it('carries no unreviewed date', () => {
    const raw = JSON.stringify(assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT, TODAY));
    for (const date of unreviewedDates()) {
      expect(raw, `${date} is in the assessment payload`).not.toContain(date);
    }
    expect(JSON.parse(raw).calculatedDeadlines).toEqual([]);
  });

  it('reports the discount window as unknowable rather than passed', () => {
    const result = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT, '2027-06-01');
    expect(result.discountStatus).toBe('UNKNOWN');
  });

  it('uses a printed deadline when the user confirmed one', () => {
    const result = assessVerifiedNotice(
      { ...WESTMINSTER, discountDeadlinePrinted: '2026-09-28' },
      EMPTY_USER_CONTEXT,
      TODAY,
    );
    expect(result.printedDeadlines).toHaveLength(1);
    expect(result.discountStatus).toBe('OPEN');
  });
});

describe('the resumed case', () => {
  it('carries no unreviewed date', () => {
    // The exact failure reported from Preview.
    const raw = JSON.stringify(buildCaseView(caseRecord(), TODAY));
    for (const date of unreviewedDates()) {
      expect(raw, `${date} is on the resumed case page`).not.toContain(date);
    }
  });

  it('shows no calculated deadline, and says why', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.deadlines.filter((d) => d.source === 'CALCULATED_BY_PCNWATCH')).toEqual([]);
    expect(view.refusedDeadlines.some((r) => r.reason === 'RULE_AWAITING_REVIEW')).toBe(true);
  });

  it('cannot produce PASSED from an unreviewed rule', () => {
    const view = buildCaseView(caseRecord(), '2027-06-01');
    expect(view.nextAction.urgency).not.toBe('OVERDUE');
    expect(view.nextAction.headline).not.toMatch(/passed/i);
    expect(view.discountStatus).toBe('UNKNOWN');
  });

  it('cannot remove the discounted amount from an unreviewed rule', () => {
    // What the Preview case did: "The discount period appears to have passed,
    // so the full amount is shown" — on a page somebody was reading to decide
    // whether to pay the reduced figure.
    const view = buildCaseView(caseRecord(), '2027-06-01');
    expect(view.financialExposure.currentlyPayablePence).toBeNull();
    expect(view.financialExposure.discountedPence).toBe(6500);
    expect(view.financialExposure.note).not.toMatch(/passed/i);
  });

  it('does let a confirmed printed deadline drive the page', () => {
    const open = buildCaseView(caseRecord({ discountDeadlinePrinted: '2026-09-28' }), TODAY);
    expect(open.discountStatus).toBe('OPEN');
    expect(open.financialExposure.currentlyPayablePence).toBe(6500);
    expect(open.deadlines.some((d) => d.source === 'PRINTED_ON_NOTICE')).toBe(true);

    const passed = buildCaseView(caseRecord({ discountDeadlinePrinted: '2026-06-28' }), TODAY);
    expect(passed.discountStatus).toBe('PASSED');
    expect(passed.financialExposure.currentlyPayablePence).toBe(13000);
  });

  it('produces the same dates as the fresh assessment for the same case', () => {
    // The two routes must agree. Disagreeing is how one of them ends up being
    // the unsafe one without anybody noticing.
    const fresh = assessVerifiedNotice(WESTMINSTER, EMPTY_USER_CONTEXT, TODAY);
    const resumed = buildCaseView(caseRecord(), TODAY);

    expect(resumed.deadlines.map((d) => d.date).sort()).toEqual(
      [...fresh.printedDeadlines, ...fresh.calculatedDeadlines].map((d) => d.date).sort(),
    );
  });
});

describe('the endpoint', () => {
  it('serves no unreviewed date over the wire', async () => {
    const response = await POST(
      new Request('http://localhost/api/cases/assess', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(WESTMINSTER),
      }),
    );
    const raw = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    for (const date of unreviewedDates()) {
      expect(raw, `${date} was served to the client`).not.toContain(date);
    }
  });
});

describe('a reviewed rule, when one exists', () => {
  it('would produce a date the product may use', () => {
    /*
     * Every rule is PENDING_LEGAL_REVIEW today, so this exercises the boundary
     * against a rule marked reviewed rather than waiting for sign-off. It is
     * what stops the gate being "return nothing, always" — which would pass
     * every other test in this file.
     */
    const reviewed = DEADLINE_RULES.map((rule) => ({ ...rule, reviewStatus: 'REVIEWED' as const }));
    const originals = DEADLINE_RULES.map((rule) => ({ ...rule }));

    DEADLINE_RULES.forEach((rule, index) => Object.assign(rule, reviewed[index]));
    try {
      const projection = projectDeadlines({
        pcnServedDate: WESTMINSTER.issueDate,
        verifiedDates: { pcnServedDate: true },
        today: TODAY,
      });

      expect(projection.calculated.length).toBeGreaterThan(0);
      expect(projection.calculated.every((d) => d.source === 'CALCULATED_BY_PCNWATCH')).toBe(true);
      expect(projection.refused.some((r) => r.reason === 'RULE_AWAITING_REVIEW')).toBe(false);
      // And a reviewed rule may decide the window.
      const late = projectDeadlines({
        pcnServedDate: WESTMINSTER.issueDate,
        verifiedDates: { pcnServedDate: true },
        today: '2027-06-01',
      });
      expect(late.discountStatus).toBe('PASSED');
    } finally {
      DEADLINE_RULES.forEach((rule, index) => Object.assign(rule, originals[index]));
    }
  });
});
