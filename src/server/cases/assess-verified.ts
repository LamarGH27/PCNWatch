import { assessCase, formatPence } from '@/core/assessment/engine';
import type { Assessment } from '@/core/assessment/types';
import { calculateAllDeadlines } from '@/core/deadlines/calculate';
import type { DeadlineResult, ServiceMethod } from '@/core/deadlines/types';
import { findRule } from '@/core/deadlines/rules';
import { getContravention, normaliseContraventionCode, toCitation } from '@/core/reference/store';
import type { NoticeType, ProceduralStage, ReferenceCitation } from '@/core/reference/types';
import { isDisplayableStage, stageForNoticeType } from '@/core/case/stage-from-notice';
import { PRIVATE_PARKING_MESSAGE } from '@/core/notices/classify-notice';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import {
  evidenceRelevance,
  reconcileContext,
  type EvidencePriority,
} from '@/core/context/reconcile';
import { evidenceForAssertion } from '@/core/context/questions';
import type { EvidenceType } from '@/core/evidence/types';
import {
  classifyAuthorityName,
  hasReviewedAuthorityGuidance,
} from '@/core/notices/classify-authority';

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
  /** The deadline's own name, so the user knows which one is missing. */
  readonly label: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * A piece of evidence to gather, and how prominently to ask for it.
 *
 * Ordered server-side rather than in the view, so what a user is asked for is
 * deterministic, testable, and the same wherever the assessment is rendered.
 */
export interface EvidenceGuidance {
  readonly type: EvidenceType;
  readonly priority: EvidencePriority;
  readonly reason: string | null;
}

export interface ContraventionMeaning {
  readonly code: string;
  /** The approved plain-English meaning, or null when we hold none. */
  readonly meaning: string | null;
  readonly citation: ReferenceCitation | null;
  /** What the notice itself called it. Shown alongside, never instead. */
  readonly asPrintedOnNotice: string | null;
}

/**
 * How much PCNWatch holds about the issuing authority.
 *
 * Never affects whether a notice is supported. A Westminster PCN is a
 * local-authority PCN whether or not we have ever ingested a Westminster row.
 */
export type AuthorityCoverage = 'REVIEWED' | 'LIMITED' | 'NONE';

export interface VerifiedAssessment {
  readonly supported: boolean;
  readonly unsupportedMessage: string | null;
  readonly authority: {
    readonly name: string | null;
    readonly recognised: boolean;
    readonly slug: string | null;
    readonly coverage: AuthorityCoverage;
    /** What we can and cannot say about this authority, in plain words. */
    readonly coverageNote: string | null;
  };
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
  /**
   * Evidence to gather, most relevant first.
   *
   * Derived from the confirmed facts as well as the contravention, which is the
   * fix for an assessment that asked someone who had just said they paid by app
   * to produce a parking permit at the top of the list. Nothing is dropped —
   * only ordered and, where a confirmed fact makes it unlikely, labelled as
   * such.
   */
  readonly evidenceGuidance: readonly EvidenceGuidance[];
}

/** Notice types served on the vehicle rather than posted, for deemed service. */
const SERVICE_METHOD: Partial<Record<NoticeType, ServiceMethod>> = {
  PCN_ON_STREET: 'AFFIXED_TO_VEHICLE',
  PCN_POSTAL: 'POSTED',
};

/**
 * The verified notice plus whatever the user has since told us.
 *
 * Separate arguments on purpose. The context can add findings, add missing
 * information and move the evidence basis; it can never change a fact the user
 * verified from the notice, and keeping the two apart is what makes that
 * checkable rather than merely intended.
 */
export function assessVerifiedNotice(
  facts: VerifiedFacts,
  context: UserContext = EMPTY_USER_CONTEXT,
): VerifiedAssessment {
  const code = facts.contraventionCode
    ? normaliseContraventionCode(facts.contraventionCode)
    : null;
  const reference = code ? getContravention(code) : undefined;

  /*
   * Two independent signals decide the category, and the authority's name is
   * the stronger one.
   *
   * A real Westminster PCN was being called an unidentifiable document. The
   * proximate bug was elsewhere, but the design was fragile too: the category
   * came from the notice *type* alone, so anything that left the type at
   * UNKNOWN — a photograph that cut off the heading, a layout the reader had
   * not seen — took the whole notice out of scope, however plainly "Westminster
   * City Council" was printed on it.
   *
   * The name the user confirmed now decides it. A council is a council whether
   * or not PCNWatch has ever held data about it.
   */
  const authority = classifyAuthorityName(facts.authorityName);

  const noticeCategory = ((): 'LOCAL_AUTHORITY_PCN' | 'PRIVATE_PARKING_CHARGE' | 'UNKNOWN' => {
    // An explicit private charge stays out, on either signal.
    if (facts.noticeType === 'PRIVATE_PARKING_CHARGE') return 'PRIVATE_PARKING_CHARGE';
    if (authority.kind === 'PRIVATE_OPERATOR') return 'PRIVATE_PARKING_CHARGE';

    // A recognised council settles it even when the notice type did not read.
    if (authority.kind === 'LOCAL_AUTHORITY') return 'LOCAL_AUTHORITY_PCN';

    // Otherwise the notice type is all we have. A statutory notice type is
    // itself proof of a statutory process.
    if (facts.noticeType !== 'UNKNOWN') return 'LOCAL_AUTHORITY_PCN';

    // Neither signal identified it. This is the genuine unknown.
    return 'UNKNOWN';
  })();

  const coverage: AuthorityCoverage =
    authority.kind !== 'LOCAL_AUTHORITY'
      ? 'NONE'
      : hasReviewedAuthorityGuidance(authority.authoritySlug)
        ? 'REVIEWED'
        : 'LIMITED';

  const stage = stageForNoticeType(facts.noticeType);

  const assessment = assessCase({
    contraventionCode: code,
    proceduralStage: stage,
    noticeCategory,
    // Nothing is asserted as a ground yet: the user has confirmed what the
    // notice says, not what they want to argue.
    /*
     * Still empty, and deliberately.
     *
     * A ground is something the user decides to rely on. Answering "yes, I had
     * a permit" is a claim about what happened, not a decision to argue that the
     * contravention did not occur, and turning the first into the second is
     * precisely how a tool starts inventing defences on people's behalf. The
     * free assessment therefore asserts no ground; choosing one is a later,
     * explicit act.
     */
    assertedGroundKeys: [],
    /*
     * Evidence PCNWatch holds. Nothing is uploaded in this flow yet, so this
     * stays empty even when the user has told us they hold documents — what
     * they told us travels in `userContext` and is never counted here.
     */
    evidenceProvided: {},
    userNarrativeProvided: context.narrativeProvided,
    userContext: context,
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
    const rule = findRule(result.deadlineType);
    // A rule's own name, not the enum. "We do not have the date this deadline
    // runs from" repeated five times told nobody which deadline was missing.
    const label = rule?.label ?? humaniseDeadlineType(result.deadlineType);

    if (!result.calculated) {
      // Named. The engine's message is the same sentence for every deadline
      // that shares a trigger date, so five of them read as one problem
      // repeated rather than five distinct things we could not tell you.
      refusedDeadlines.push({
        label,
        reason: result.reason,
        message: `${label}: ${lowerFirst(result.message)}`,
      });
      continue;
    }

    /*
     * A timing rule still awaiting legal review does not produce a date the
     * user sees.
     *
     * The engine computed one and attached "This timing rule is awaiting
     * review by a qualified person" beside it — which is a date and a
     * disclaimer occupying the same space, and people act on the date. Someone
     * missing a statutory deadline because we showed an unreviewed calculation
     * is the harm this exists to prevent, and it is worse than showing nothing.
     *
     * The arithmetic is unchanged and still deterministic; it is only withheld
     * from display. When a rule is signed off, its date appears with no other
     * change.
     */
    if (rule && rule.reviewStatus !== 'REVIEWED') {
      refusedDeadlines.push({
        label,
        reason: 'RULE_AWAITING_REVIEW',
        message:
          `${label}: PCNWatch can work this date out, but the timing rule behind it has not ` +
          'yet been checked by a qualified person, so we will not show you a date to act on. ' +
          'Use the deadline printed on your notice.',
      });
      continue;
    }

    calculatedDeadlines.push({
      label,
      date: result.calculatedDueDate,
      source: 'CALCULATED_BY_PCNWATCH',
      basis: result.triggerDescription,
      confidence: result.confidence,
      warnings: result.warnings,
    });
  }

  /* -- Evidence, ordered by what the user has actually told us ------------- */

  const reconciled = reconcileContext(
    context.answers,
    context.confirmedAssertions,
    context.resolvedFacts,
  );

  const PRIORITY_ORDER: Record<EvidencePriority, number> = {
    PRIORITY: 0,
    STANDARD: 1,
    LESS_LIKELY: 2,
  };

  const neededTypes = [
    ...new Set(assessment.findings.flatMap((finding) => finding.evidenceNeeded)),
  ] as EvidenceType[];

  const evidenceGuidance: EvidenceGuidance[] = neededTypes
    .map((type) => {
      // Which confirmed facts this document would corroborate. Derived from the
      // one assertion-to-evidence mapping rather than a second table.
      const supports = reconciled.facts
        .map((fact) => fact.topic)
        .filter((topic) => evidenceForAssertion(topic).includes(type));
      const { priority, reason } = evidenceRelevance(type, supports, reconciled.facts);
      return { type, priority, reason };
    })
    .sort((a, b) => {
      const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      // Stable within a band, so the order does not shuffle between renders.
      return byPriority !== 0 ? byPriority : neededTypes.indexOf(a.type) - neededTypes.indexOf(b.type);
    });

  return {
    supported: noticeCategory === 'LOCAL_AUTHORITY_PCN',
    authority: {
      name: facts.authorityName ?? null,
      recognised: authority.kind === 'LOCAL_AUTHORITY',
      slug: authority.authoritySlug,
      coverage,
      coverageNote:
        coverage === 'LIMITED'
          ? 'The national rules below apply to this notice. PCNWatch does not yet hold ' +
            'enforcement history or reviewed procedure notes for this authority, so ' +
            'anything specific to how they handle challenges is not covered here.'
          : null,
    },
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
    evidenceGuidance,
    amountSummary: {
      full: facts.fullAmountPence !== undefined ? formatPence(facts.fullAmountPence) : null,
      discounted:
        facts.discountedAmountPence !== undefined
          ? formatPence(facts.discountedAmountPence)
          : null,
    },
  };
}

/** Lower-cases the first letter so a message reads on from its label. */
function lowerFirst(sentence: string): string {
  // Only when the second character is lower case, so "PCNWatch can…" survives.
  if (sentence.length < 2 || sentence[1] !== sentence[1]!.toLowerCase()) return sentence;
  return sentence.charAt(0).toLowerCase() + sentence.slice(1);
}

/** Fallback name for a deadline with no rule of its own. */
function humaniseDeadlineType(deadlineType: string): string {
  const words = deadlineType.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
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
