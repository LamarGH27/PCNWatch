import { assessCase, formatPence } from '@/core/assessment/engine';
import type { Assessment } from '@/core/assessment/types';
import { calculateAllDeadlines } from '@/core/deadlines/calculate';
import type { DeadlineResult, ServiceMethod } from '@/core/deadlines/types';
import { getContravention, normaliseContraventionCode, toCitation } from '@/core/reference/store';
import type { NoticeType, ProceduralStage, ReferenceCitation } from '@/core/reference/types';
import { isDisplayableStage, stageForNoticeType } from '@/core/case/stage-from-notice';
import { PRIVATE_PARKING_MESSAGE } from '@/core/notices/classify-notice';

/**
 * The free assessment, built from facts the user has confirmed.
 *
 * Composition only. Every judgement here already existed and is reused
 * unchanged: `assessCase` produces findings and the evidence basis,
 * `calculateAllDeadlines` produces dates, and the contravention meaning comes
 * from the approved reference store. Nothing new decides anything, and no
 * model is involved at any point.
 *
 * Two rules the shape of this function exists to enforce:
 *
 *  - Only confirmed values are used. An extracted value the user did not tick
 *    is not passed in, so it cannot reach a deadline or a finding.
 *  - A deadline printed on the notice and a deadline PCNWatch worked out are
 *    kept in separate fields and never merged. They carry different authority
 *    and the user has to be able to tell which is which.
 */

/** A fact the user confirmed. Absent means they did not confirm it. */
export interface VerifiedFacts {
  readonly authorityName?: string;
  readonly pcnNumber?: string;
  readonly vehicleRegistration?: string;
  readonly noticeType: NoticeType;
  readonly contraventionCode?: string;
  readonly contraventionDescription?: string;
  readonly incidentDate?: string;
  readonly incidentTime?: string;
  readonly issueDate?: string;
  readonly location?: string;
  readonly fullAmountPence?: number;
  readonly discountedAmountPence?: number;
  /** Deadlines as printed on the notice, never computed. */
  readonly discountDeadlinePrinted?: string;
  readonly representationDeadlinePrinted?: string;
}

export interface PrintedDeadline {
  readonly label: string;
  readonly date: string;
  readonly source: 'PRINTED_ON_NOTICE';
}

export interface CalculatedDeadline {
  readonly label: string;
  readonly date: string;
  readonly source: 'CALCULATED_BY_PCNWATCH';
  readonly basis: string;
  readonly confidence: string;
  readonly warnings: readonly string[];
}

export interface RefusedDeadline {
  readonly label: string;
  readonly reason: string;
  readonly message: string;
}

export interface ContraventionMeaning {
  readonly code: string;
  /** The approved plain-English meaning, or null when we hold none. */
  readonly meaning: string | null;
  readonly citation: ReferenceCitation | null;
  /** What the notice itself called it. Shown alongside, never instead. */
  readonly asPrintedOnNotice: string | null;
}

export interface VerifiedAssessment {
  readonly supported: boolean;
  readonly unsupportedMessage: string | null;
  readonly assessment: Assessment;
  readonly contravention: ContraventionMeaning;
  readonly stage: ProceduralStage;
  readonly stageIsKnown: boolean;
  readonly printedDeadlines: readonly PrintedDeadline[];
  readonly calculatedDeadlines: readonly CalculatedDeadline[];
  readonly refusedDeadlines: readonly RefusedDeadline[];
  readonly amountSummary: {
    readonly full: string | null;
    readonly discounted: string | null;
  };
}

/** Notice types served on the vehicle rather than posted, for deemed service. */
const SERVICE_METHOD: Partial<Record<NoticeType, ServiceMethod>> = {
  PCN_ON_STREET: 'AFFIXED_TO_VEHICLE',
  PCN_POSTAL: 'POSTED',
};

export function assessVerifiedNotice(facts: VerifiedFacts): VerifiedAssessment {
  const code = facts.contraventionCode
    ? normaliseContraventionCode(facts.contraventionCode)
    : null;
  const reference = code ? getContravention(code) : undefined;

  const noticeCategory =
    facts.noticeType === 'PRIVATE_PARKING_CHARGE'
      ? ('PRIVATE_PARKING_CHARGE' as const)
      : facts.noticeType === 'UNKNOWN'
        ? ('UNKNOWN' as const)
        : ('LOCAL_AUTHORITY_PCN' as const);

  const stage = stageForNoticeType(facts.noticeType);

  const assessment = assessCase({
    contraventionCode: code,
    proceduralStage: stage,
    noticeCategory,
    // Nothing is asserted as a ground yet: the user has confirmed what the
    // notice says, not what they want to argue.
    assertedGroundKeys: [],
    evidenceProvided: {},
    userNarrativeProvided: false,
    verifiedFields: {
      pcnNumber: facts.pcnNumber !== undefined,
      contraventionCode: code !== null,
      incidentDate: facts.incidentDate !== undefined,
      location: facts.location !== undefined,
      amount: facts.fullAmountPence !== undefined,
    },
  });

  /* -- Deadlines ---------------------------------------------------------- */

  // Printed dates are reported exactly as the notice gave them.
  const printedDeadlines: PrintedDeadline[] = [];
  if (facts.discountDeadlinePrinted) {
    printedDeadlines.push({
      label: 'Discount period ends',
      date: facts.discountDeadlinePrinted,
      source: 'PRINTED_ON_NOTICE',
    });
  }
  if (facts.representationDeadlinePrinted) {
    printedDeadlines.push({
      label: 'Representations due',
      date: facts.representationDeadlinePrinted,
      source: 'PRINTED_ON_NOTICE',
    });
  }

  // Calculated dates come only from a confirmed issue date. Without one the
  // engine refuses, and the refusal is shown rather than hidden.
  const results: DeadlineResult[] =
    noticeCategory === 'LOCAL_AUTHORITY_PCN'
      ? calculateAllDeadlines({
          pcnServedDate: facts.issueDate,
          serviceMethod: SERVICE_METHOD[facts.noticeType],
          verifiedDates: facts.issueDate ? { pcnServedDate: true } : undefined,
        })
      : [];

  const calculatedDeadlines: CalculatedDeadline[] = [];
  const refusedDeadlines: RefusedDeadline[] = [];
  for (const result of results) {
    if (result.calculated) {
      calculatedDeadlines.push({
        label: result.label,
        date: result.calculatedDueDate,
        source: 'CALCULATED_BY_PCNWATCH',
        basis: result.triggerDescription,
        confidence: result.confidence,
        warnings: result.warnings,
      });
    } else {
      refusedDeadlines.push({
        label: result.deadlineType.replace(/_/g, ' ').toLowerCase(),
        reason: result.reason,
        message: result.message,
      });
    }
  }

  return {
    supported: noticeCategory === 'LOCAL_AUTHORITY_PCN',
    unsupportedMessage:
      noticeCategory === 'PRIVATE_PARKING_CHARGE'
        ? PRIVATE_PARKING_MESSAGE
        : noticeCategory === 'UNKNOWN'
          ? 'We could not tell what kind of notice this is, so we have not applied local-authority rules to it.'
          : null,
    assessment,
    contravention: {
      code: code ?? '',
      // Null when we hold no approved record. The model is never asked to
      // supply the meaning of a contravention.
      meaning: reference?.summary ?? null,
      citation: reference ? toCitation(reference) : null,
      asPrintedOnNotice: facts.contraventionDescription ?? null,
    },
    stage,
    stageIsKnown: isDisplayableStage(stage),
    printedDeadlines,
    calculatedDeadlines,
    refusedDeadlines,
    amountSummary: {
      full: facts.fullAmountPence !== undefined ? formatPence(facts.fullAmountPence) : null,
      discounted:
        facts.discountedAmountPence !== undefined
          ? formatPence(facts.discountedAmountPence)
          : null,
    },
  };
}

/**
 * Masks a PCN number for display.
 *
 * The number identifies the notice to the authority and appears on screen in
 * public places — a phone held up in the street. Enough is shown to recognise
 * which notice this is without reproducing the whole thing.
 */
export function maskPcnNumber(pcnNumber: string): string {
  const trimmed = pcnNumber.trim();
  if (trimmed.length <= 4) return trimmed;
  return `${trimmed.slice(0, 2)}${'•'.repeat(Math.max(trimmed.length - 4, 1))}${trimmed.slice(-2)}`;
}
