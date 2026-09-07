import { describe, expect, it } from 'vitest';
import { buildCaseView, type CaseRecord } from '@/server/cases/case-view';
import { evidenceItem } from '../fixtures/evidence';

const TODAY = '2026-01-15';

/*
 * A case whose deadlines came off the notice.
 *
 * Every timing rule PCNWatch holds is still PENDING_LEGAL_REVIEW, so a
 * calculated date is withheld and cannot drive anything. A date the user read
 * off their own notice can — it is theirs, not ours — and these tests use one
 * so that the behaviour they cover (discount window, urgency, overdue) is still
 * exercised rather than quietly dropped along with the unsafe path.
 */
function printedRecord(discountDeadline: string, overrides: Partial<CaseRecord> = {}): CaseRecord {
  return caseRecord({ discountDeadlinePrinted: discountDeadline, ...overrides });
}

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
    discountDeadlinePrinted: null,
    representationDeadlinePrinted: null,
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
    // Held, read and confirmed. Anything short of that supports nothing.
    evidenceItems: [evidenceItem('PCN_IMAGE', 'VERIFIED')],
    vehicleRegistration: null,
    incidentTime: null,
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
    // The discount deadline printed on the notice is 19 Jan; today is 15 Jan.
    const view = buildCaseView(printedRecord('2026-01-19'), TODAY);
    expect(view.discountStatus).toBe('OPEN');
    expect(view.financialExposure.currentlyPayablePence).toBe(6500);
    expect(view.financialExposure.note).toContain('reduced amount');
  });

  it('shows the full amount once the discount period has passed', () => {
    const view = buildCaseView(printedRecord('2026-01-19'), '2026-01-25');
    expect(view.financialExposure.currentlyPayablePence).toBe(13000);
    expect(view.financialExposure.note).toContain('passed');
  });

  it('will not decide the payable amount from a rule awaiting review', () => {
    /*
     * The regression this file did not catch. With no printed deadline the only
     * thing that could answer "has the discount period passed?" is an unreviewed
     * calculation — so the answer is that we cannot say, and the reduced figure
     * stays on the page for the user to consider.
     */
    const view = buildCaseView(caseRecord(), '2026-02-25');
    expect(view.discountStatus).toBe('UNKNOWN');
    expect(view.financialExposure.currentlyPayablePence).toBeNull();
    expect(view.financialExposure.note).toContain('check the dates');
    expect(view.financialExposure.note).not.toContain('passed');
    // The reduced amount is still reported, not removed.
    expect(view.financialExposure.discountedPence).toBe(6500);
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
    const view = buildCaseView(printedRecord('2026-01-19'), TODAY);
    expect(view.nextAction.daysRemaining).toBe(4);
    expect(view.nextAction.urgency).toBe('SOON');
    expect(view.nextAction.headline).toContain('4 days left');
  });

  it('escalates urgency as a deadline approaches', () => {
    expect(buildCaseView(printedRecord('2026-01-19'), '2026-01-17').nextAction.urgency).toBe('URGENT');
    expect(buildCaseView(printedRecord('2026-01-19'), '2026-01-19').nextAction.urgency).toBe('URGENT');
    expect(buildCaseView(printedRecord('2026-01-19'), '2026-01-06').nextAction.urgency).toBe('ROUTINE');
  });

  it('reports an overdue deadline without pretending it is still open', () => {
    const view = buildCaseView(printedRecord('2026-01-19'), '2026-02-20');
    expect(view.nextAction.urgency).toBe('OVERDUE');
    expect(view.nextAction.headline).toContain('has passed');
    expect(view.nextAction.detail).toContain('printed on your notice');
  });

  it('never reports anything as passed on the strength of an unreviewed rule', () => {
    // Long after every calculated date would have expired. Without a printed
    // deadline there is nothing safe to be overdue against.
    const view = buildCaseView(caseRecord(), '2027-06-01');
    expect(view.nextAction.urgency).not.toBe('OVERDUE');
    expect(view.nextAction.headline).not.toMatch(/passed/i);
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

  it('shows no date at all from a rule awaiting review', () => {
    /*
     * This test used to accept an unreviewed date so long as it carried a
     * warning and a lowered confidence. That is what a real saved case
     * displayed: two dates from PENDING_LEGAL_REVIEW rules, one badged
     * "Passed". People act on the date, not the warning under it.
     */
    const view = buildCaseView(caseRecord(), TODAY);

    const discount = view.deadlines.find((d) => d.label === 'Discounted amount deadline');
    expect(discount, 'an unreviewed rule produced a date').toBeUndefined();

    // Named as refused rather than silently missing.
    const refused = view.refusedDeadlines.find((d) => d.label === 'Discounted amount deadline');
    expect(refused).toBeDefined();
    expect(refused!.reason).toBe('RULE_AWAITING_REVIEW');
  });

  it('refuses a deadline whose trigger date we do not have', () => {
    const view = buildCaseView(caseRecord(), TODAY);
    const tribunal = view.refusedDeadlines.find((d) => d.label === 'Tribunal appeal deadline');
    expect(tribunal).toBeDefined();
    expect(tribunal!.reason).toBe('MISSING_TRIGGER_DATE');
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
        evidenceItems: [],
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
