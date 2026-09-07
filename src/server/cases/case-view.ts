import {
  projectDeadlines,
  type DeadlineProjection,
  type RefusedDeadline,
  type SafeDeadline,
  type WindowStatus,
} from '@/core/deadlines/projection';
import { buildEvidenceChecklist } from '@/core/evidence/checklist';
import type { EvidenceChecklist, EvidenceType } from '@/core/evidence/types';
import { assessCase } from '@/core/assessment/engine';
import type { Assessment } from '@/core/assessment/types';
import { STAGE_LABELS, isTerminal } from '@/core/case/state-machine';
import { getReference } from '@/core/reference/store';
import type { UserContext } from '@/core/context/types';
import type { ProceduralStage } from '@/core/reference/types';

/**
 * Assembles everything a case dashboard shows, from the case record plus the
 * deterministic engines.
 *
 * Nothing here calls a model. The dashboard is entirely rules-driven, which is
 * why it can be tested exactly and why it works identically whether or not the
 * AI integration is configured.
 */

export interface CaseRecord {
  readonly id: string;
  readonly pcnNumber: string | null;
  readonly authorityName: string | null;
  readonly authoritySlug: string | null;
  readonly noticeCategory: 'LOCAL_AUTHORITY_PCN' | 'PRIVATE_PARKING_CHARGE' | 'UNKNOWN';
  readonly contraventionCode: string | null;
  readonly contraventionSuffix: string | null;
  readonly incidentDate: string | null;
  readonly issueDate: string | null;
  readonly noticeToOwnerServedDate: string | null;
  readonly noticeOfRejectionServedDate: string | null;
  readonly locationText: string | null;
  /**
   * Deadlines printed on the notice and confirmed by the user.
   *
   * These were not on the record at all, which is part of why the saved-case
   * page leaned on calculated dates: the only dates it had were ones it worked
   * out. A printed date is the user's own reading of their own notice and is
   * the one thing here that may always be shown.
   */
  readonly discountDeadlinePrinted: string | null;
  readonly representationDeadlinePrinted: string | null;
  readonly parkingLocationSlug: string | null;
  readonly fullAmountPence: number | null;
  readonly discountedAmountPence: number | null;
  readonly proceduralStage: ProceduralStage;
  /** Whether the user wrote an account. Never the account — it is not stored. */
  readonly narrativeProvided: boolean;
  readonly contextAnswers: UserContext['answers'];
  readonly confirmedAssertions: UserContext['confirmedAssertions'];
  readonly declaredEvidence: UserContext['declaredEvidence'];
  readonly resolvedFacts: UserContext['resolvedFacts'];
  readonly assertedGroundKeys: readonly string[];
  readonly verifiedFields: Readonly<Record<string, boolean>>;
  readonly evidenceCounts: Partial<Record<EvidenceType, number>>;
  readonly closedAt: string | null;
}

export type NextActionUrgency = 'NONE' | 'ROUTINE' | 'SOON' | 'URGENT' | 'OVERDUE';

export interface NextAction {
  readonly headline: string;
  readonly detail: string;
  readonly urgency: NextActionUrgency;
  readonly deadline: SafeDeadline | null;
  readonly daysRemaining: number | null;
}

export interface CaseView {
  readonly stage: ProceduralStage;
  readonly stageLabel: string;
  readonly stageExplanation: string | null;
  readonly isClosed: boolean;
  readonly financialExposure: {
    readonly discountedPence: number | null;
    readonly fullPence: number | null;
    readonly currentlyPayablePence: number | null;
    readonly note: string;
  };
  /**
   * Every date this case may show. Printed first, then calculated — and only
   * ever ones the boundary let through.
   */
  readonly deadlines: readonly SafeDeadline[];
  /** Dates we will not give, each with the reason. Shown, not hidden. */
  readonly refusedDeadlines: readonly RefusedDeadline[];
  readonly discountStatus: WindowStatus;
  readonly nextAction: NextAction;
  readonly evidence: EvidenceChecklist;
  readonly assessment: Assessment;
  readonly outOfScopeMessage: string | null;
}

/** Days at which a deadline moves from ROUTINE to SOON to URGENT. */
export const URGENCY_THRESHOLDS = { urgent: 3, soon: 7 } as const;

export function buildCaseView(record: CaseRecord, today: string): CaseView {
  /*
   * Through the shared boundary, like every other route.
   *
   * This used to call `calculateAllDeadlines` directly with
   * `requireReviewedRules: true`, which reads like a safety flag and is not
   * one: it lowers a confidence label from HIGH to MEDIUM and still returns the
   * date. So a resumed case displayed two dates from rules marked
   * PENDING_LEGAL_REVIEW, badged one of them "Passed", and told the user their
   * discount period had expired — the exact outcome the gate on the fresh
   * assessment was built to prevent, on a route that never went through it.
   *
   * The projection returns nothing that has not been signed off or read off the
   * user's own notice, so everything below can use what it gets without
   * checking again.
   */
  const projection = projectDeadlines({
    pcnServedDate: record.issueDate ?? undefined,
    noticeToOwnerServedDate: record.noticeToOwnerServedDate ?? undefined,
    noticeOfRejectionServedDate: record.noticeOfRejectionServedDate ?? undefined,
    verifiedDates: {
      pcnServedDate: record.verifiedFields.issueDate === true,
      noticeToOwnerServedDate: record.verifiedFields.noticeToOwnerServedDate === true,
      noticeOfRejectionServedDate: record.verifiedFields.noticeOfRejectionServedDate === true,
    },
    printedDeadlines: {
      discountDeadline: record.discountDeadlinePrinted ?? undefined,
      representationDeadline: record.representationDeadlinePrinted ?? undefined,
    },
    calculationApplies: record.noticeCategory === 'LOCAL_AUTHORITY_PCN',
    today,
  });

  const evidence = buildEvidenceChecklist({
    contraventionCode: record.contraventionCode,
    assertedGroundKeys: record.assertedGroundKeys,
    provided: record.evidenceCounts,
  });

  const assessment = assessCase({
    contraventionCode: record.contraventionCode,
    contraventionSuffix: record.contraventionSuffix,
    proceduralStage: record.proceduralStage,
    noticeCategory: record.noticeCategory,
    assertedGroundKeys: record.assertedGroundKeys,
    evidenceProvided: record.evidenceCounts,
    userNarrativeProvided: record.narrativeProvided,
    /*
     * The canonical context, rebuilt from the row rather than recomputed from
     * nothing. A resumed case has to produce the same assessment as the one the
     * user saw before they closed the page, and it can only do that if what
     * they confirmed comes back with it.
     */
    userContext: {
      narrativeProvided: record.narrativeProvided,
      answers: record.contextAnswers,
      declaredEvidence: record.declaredEvidence,
      confirmedAssertions: record.confirmedAssertions,
      resolvedFacts: record.resolvedFacts,
    },
    verifiedFields: {
      pcnNumber: record.verifiedFields.pcnNumber === true,
      contraventionCode: record.verifiedFields.contraventionCode === true,
      incidentDate: record.verifiedFields.incidentDate === true,
      location: record.verifiedFields.location === true,
      amount: record.verifiedFields.fullAmountPence === true,
    },
  });

  const procedureRecord = procedureFor(record.proceduralStage);

  return {
    stage: record.proceduralStage,
    stageLabel: STAGE_LABELS[record.proceduralStage],
    stageExplanation: procedureRecord?.summary ?? null,
    isClosed: isTerminal(record.proceduralStage),
    financialExposure: financialExposure(record, projection),
    deadlines: [...projection.printed, ...projection.calculated],
    refusedDeadlines: projection.refused,
    discountStatus: projection.discountStatus,
    nextAction: nextAction(record, projection, evidence, today),
    evidence,
    assessment,
    outOfScopeMessage: assessment.outOfScopeMessage,
  };
}

const PROCEDURE_KEY_BY_STAGE: Partial<Record<ProceduralStage, string>> = {
  NEW: 'PROCEDURE-NEW',
  INFORMAL_CHALLENGE: 'PROCEDURE-INFORMAL-CHALLENGE',
  NOTICE_TO_OWNER: 'PROCEDURE-NTO',
  FORMAL_REPRESENTATION: 'PROCEDURE-FORMAL-REPS',
  NOTICE_OF_REJECTION: 'PROCEDURE-REJECTION',
  NOTICE_OF_ACCEPTANCE: 'PROCEDURE-ACCEPTANCE',
  TRIBUNAL_APPEAL: 'PROCEDURE-TRIBUNAL',
  TRIBUNAL_ELIGIBLE: 'PROCEDURE-REJECTION',
};

function procedureFor(stage: ProceduralStage) {
  const key = PROCEDURE_KEY_BY_STAGE[stage];
  return key ? getReference(key) : undefined;
}

/**
 * What the user is currently exposed to financially.
 *
 * The discounted figure is only presented as payable while its deadline has not
 * passed. Showing a discount the user can no longer take would be a small lie
 * with a real cost attached.
 */
function financialExposure(
  record: CaseRecord,
  projection: DeadlineProjection,
): CaseView['financialExposure'] {
  /*
   * Decided from the projection's own verdict, never from a date this function
   * inspects itself.
   *
   * The previous version reached into the raw deadline results for
   * DISCOUNT_EXPIRY and compared its date to today — which is how an unreviewed
   * calculation came to remove the reduced figure from a page somebody was
   * reading in order to decide whether to pay it. UNKNOWN is now a real answer
   * and produces the honest note below.
   */
  const discountStillOpen =
    projection.discountStatus === 'UNKNOWN' ? null : projection.discountStatus === 'OPEN';

  if (record.fullAmountPence === null && record.discountedAmountPence === null) {
    return {
      discountedPence: null,
      fullPence: null,
      currentlyPayablePence: null,
      note: 'We do not have the amounts from your notice yet, so we are not showing a figure.',
    };
  }

  if (discountStillOpen === null) {
    return {
      discountedPence: record.discountedAmountPence,
      fullPence: record.fullAmountPence,
      currentlyPayablePence: null,
      note: 'We cannot work out whether the discount period is still open, so check the dates on your notice.',
    };
  }

  return {
    discountedPence: record.discountedAmountPence,
    fullPence: record.fullAmountPence,
    currentlyPayablePence: discountStillOpen
      ? record.discountedAmountPence ?? record.fullAmountPence
      : record.fullAmountPence,
    note: discountStillOpen
      ? 'The reduced amount is currently shown as payable. Paying it normally ends the case.'
      : 'The discount period appears to have passed, so the full amount is shown.',
  };
}

/**
 * The single next thing to do.
 *
 * Ordered by what actually costs the user something: a deadline that has passed
 * or is close, then the gap that most weakens their position, then routine work.
 */
function nextAction(
  record: CaseRecord,
  projection: DeadlineProjection,
  evidence: EvidenceChecklist,
  today: string,
): NextAction {
  // Only dates that crossed the boundary. A deadline we refused to give cannot
  // become "Passed", cannot become urgent, and cannot narrow what we tell the
  // user their options are.
  const deadlines = [...projection.printed, ...projection.calculated];
  if (isTerminal(record.proceduralStage)) {
    return {
      headline: 'This case is closed.',
      detail: 'Nothing further is required. Your documents remain available until you delete them.',
      urgency: 'NONE',
      deadline: null,
      daysRemaining: null,
    };
  }

  if (record.noticeCategory === 'PRIVATE_PARKING_CHARGE') {
    return {
      headline: 'This is a private parking charge.',
      detail:
        'This version of PCNWatch currently focuses on local-authority PCNs. Private parking charges follow a different process.',
      urgency: 'NONE',
      deadline: null,
      daysRemaining: null,
    };
  }

  // The soonest deadline that has not passed, or the most recently passed one.
  // Every candidate is already safe: `deadlines` is what the projection let
  // through, so there is no filtering for review status to forget here.
  const upcoming = deadlines
    .filter((d) => d.date >= today)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const overdue = deadlines
    .filter((d) => d.date < today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];

  if (upcoming) {
    const days = daysBetweenIso(today, upcoming.date);
    return {
      headline: `${upcoming.label}: ${days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'} left`}`,
      detail:
        evidence.missingEssential.length > 0
          ? `Before that date, add the evidence still missing from your case. ${upcoming.warnings[0] ?? ''}`.trim()
          : upcoming.warnings[0] ??
            'Decide whether to pay or to challenge, and submit before this date.',
      urgency:
        days <= URGENCY_THRESHOLDS.urgent ? 'URGENT' : days <= URGENCY_THRESHOLDS.soon ? 'SOON' : 'ROUTINE',
      deadline: upcoming,
      daysRemaining: days,
    };
  }

  if (overdue) {
    return {
      headline: `${overdue.label} has passed.`,
      detail:
        'Check the date printed on your notice — ours is calculated and may not match. If it has genuinely passed, your remaining options are narrower.',
      urgency: 'OVERDUE',
      deadline: overdue,
      daysRemaining: -daysBetweenIso(overdue.date, today),
    };
  }

  if (evidence.missingEssential.length > 0) {
    return {
      headline: 'Add the evidence your case needs.',
      detail: `${evidence.missingEssential.length} essential item${evidence.missingEssential.length === 1 ? ' is' : 's are'} missing. Without them your account cannot be corroborated.`,
      urgency: 'ROUTINE',
      deadline: null,
      daysRemaining: null,
    };
  }

  return {
    headline: 'Confirm the details from your notice.',
    detail:
      'We calculate deadlines only from dates you have confirmed, so confirming them is what unlocks the rest.',
    urgency: 'ROUTINE',
    deadline: null,
    daysRemaining: null,
  };
}

function daysBetweenIso(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00.000Z`);
  const b = Date.parse(`${to}T00:00:00.000Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}
