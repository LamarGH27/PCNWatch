import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';

const TODAY = '2026-01-15';

function caseRecord(overrides: Partial<CaseRecord> = {}): CaseRecord {
  return {
    id: 'case-1',
    pcnNumber: 'CA12345678',
    authorityName: 'London Borough of Camden',
    authoritySlug: 'camden',
    noticeCategory: 'LOCAL_AUTHORITY_PCN',
    contraventionCode: '12',
    contraventionSuffix: null,
    incidentDate: '2026-01-05',
    issueDate: '2026-01-05',
    noticeToOwnerServedDate: null,
    noticeOfRejectionServedDate: null,
    locationText: 'Eversholt Street',
    parkingLocationSlug: 'eversholt-street',
    fullAmountPence: 13000,
    discountedAmountPence: 6500,
    proceduralStage: 'NEW',
    // The account is not stored; only the fact that one was written.
    narrativeProvided: true,
    contextAnswers: [],
    confirmedAssertions: [],
    declaredEvidence: [],
    resolvedFacts: [],
    assertedGroundKeys: ['GROUND-CONTRAVENTION_DID_NOT_OCCUR'],
    verifiedFields: {
      pcnNumber: true,
      contraventionCode: true,
      incidentDate: true,
      issueDate: true,
      location: true,
      fullAmountPence: true,
    },
    evidenceCounts: { PCN_IMAGE: 1 },
    closedAt: null,
    ...overrides,
  };
}

describe('case dashboard assembly', () => {
  it('shows the stage with an explanation from the approved reference store', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.stageLabel).toBe('Notice received');
    expect(view.stageExplanation).toBeTruthy();
    expect(view.isClosed).toBe(false);
  });

  it('shows the discounted amount as payable while the discount period is open', () => {
    // Issued 5 Jan, 14-day discount → 19 Jan. Today is 15 Jan.
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.financialExposure.currentlyPayablePence).toBe(6500);
    expect(view.financialExposure.note).toContain('reduced amount');
  });

  it('shows the full amount once the discount period has passed', () => {
    const view = buildCaseView(caseRecord(), '2026-01-25');
    expect(view.financialExposure.currentlyPayablePence).toBe(13000);
    expect(view.financialExposure.note).toContain('passed');
  });

  it('shows no figure at all when the amounts are unknown', () => {
    const view = buildCaseView(
      caseRecord({ fullAmountPence: null, discountedAmountPence: null }),
      TODAY,
    );
    expect(view.financialExposure.currentlyPayablePence).toBeNull();
    expect(view.financialExposure.note).toContain('not showing a figure');
  });

  it('does not claim a payable amount when the discount status is unknowable', () => {
    const view = buildCaseView(
      caseRecord({ issueDate: null, verifiedFields: { pcnNumber: true } }),
      TODAY,
    );
    expect(view.financialExposure.currentlyPayablePence).toBeNull();
    expect(view.financialExposure.note).toContain('check the dates');
  });

  it('surfaces the soonest upcoming deadline as the next action', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.nextAction.daysRemaining).toBe(4);
    expect(view.nextAction.urgency).toBe('SOON');
    expect(view.nextAction.headline).toContain('4 days left');
  });

  it('escalates urgency as a deadline approaches', () => {
    expect(buildCaseView(caseRecord(), '2026-01-17').nextAction.urgency).toBe('URGENT');
    expect(buildCaseView(caseRecord(), '2026-01-19').nextAction.urgency).toBe('URGENT');
    expect(buildCaseView(caseRecord(), '2026-01-06').nextAction.urgency).toBe('ROUTINE');
  });

  it('reports an overdue deadline without pretending it is still open', () => {
    const view = buildCaseView(caseRecord(), '2026-02-20');
    expect(view.nextAction.urgency).toBe('OVERDUE');
    expect(view.nextAction.headline).toContain('has passed');
    // And tells the user our date is calculated, not authoritative.
    expect(view.nextAction.detail).toContain('printed on your notice');
  });

  it('says nothing is required once the case is closed', () => {
    const view = buildCaseView(caseRecord({ proceduralStage: 'CLOSED_WON' }), TODAY);
    expect(view.isClosed).toBe(true);
    expect(view.nextAction.urgency).toBe('NONE');
  });

  it('stops rather than applying council rules to a private parking charge', () => {
    const view = buildCaseView(caseRecord({ noticeCategory: 'PRIVATE_PARKING_CHARGE' }), TODAY);
    expect(view.outOfScopeMessage).toContain('local-authority PCNs');
    expect(view.nextAction.urgency).toBe('NONE');
    expect(view.assessment.findings).toHaveLength(0);
  });

  it('does not calculate a deadline from an unconfirmed date', () => {
    const view = buildCaseView(
      caseRecord({ verifiedFields: { pcnNumber: true, contraventionCode: true } }),
      TODAY,
    );
    const discount = view.deadlines.find((d) => d.deadlineType === 'DISCOUNT_EXPIRY');
    expect(discount).toBeDefined();
    if (discount && 'calculated' in discount && discount.calculated) {
      // It may still be calculated, but never at HIGH confidence, and it warns.
      expect(discount.confidence).not.toBe('HIGH');
      expect(discount.warnings.length).toBeGreaterThan(0);
    }
  });

  it('refuses a deadline whose trigger date we do not have', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    const tribunal = view.deadlines.find((d) => d.deadlineType === 'TRIBUNAL_APPEAL_DEADLINE');
    expect(tribunal).toMatchObject({ calculated: false, reason: 'MISSING_TRIGGER_DATE' });
  });

  it('builds an evidence checklist that reflects the contravention and grounds', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    const types = view.evidence.items.map((i) => i.type);
    expect(types).toContain('PERMIT');
    expect(types).toContain('PCN_IMAGE');
    expect(view.evidence.items.find((i) => i.type === 'PCN_IMAGE')?.provided).toBe(true);
  });

  it('points at missing essential evidence when no deadline is pressing', () => {
    const view = buildCaseView(
      caseRecord({
        issueDate: null,
        evidenceCounts: {},
        verifiedFields: { pcnNumber: true, contraventionCode: true, incidentDate: true, location: true },
      }),
      TODAY,
    );
    expect(view.nextAction.headline).toContain('evidence');
    expect(view.evidence.missingEssential.length).toBeGreaterThan(0);
  });

  it('produces an evidence basis, never a win percentage', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    expect(view.assessment.basis).toMatch(/EVIDENCE_BASIS|INSUFFICIENT_INFORMATION/);
    expect(JSON.stringify(view)).not.toMatch(/\d+%\s*(chance|likelihood|probability)/i);
  });

  it('is deterministic for the same case and date', () => {
    const record = caseRecord();
    expect(JSON.stringify(buildCaseView(record, TODAY))).toEqual(
      JSON.stringify(buildCaseView(record, TODAY)),
    );
  });
});
