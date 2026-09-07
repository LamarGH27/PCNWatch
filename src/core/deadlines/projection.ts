import { calculateAllDeadlines } from './calculate';
import { findRule } from './rules';
import type { DeadlineResult, DeadlineType, ServiceMethod } from './types';

/**
 * The only way a date may reach a user.
 *
 * The deadline engine calculates freely and always has — that is its job, and
 * nothing here changes it. What this adds is the boundary the engine's output
 * has to cross before anybody sees it, and the rule at that boundary is narrow:
 * a date computed from a timing rule still awaiting legal review does not come
 * out of this function, in any form, for any purpose.
 *
 * This existed once before, inline in `assessVerifiedNotice`, and covered the
 * one route that went through it. The saved-case page composed its own view
 * straight from `calculateAllDeadlines` and so displayed exactly what the gate
 * was written to prevent: two unreviewed dates, a "Passed" badge derived from
 * one of them, and a discount described as expired on the strength of the
 * other. `requireReviewedRules` had been passed to the engine, which was the
 * trap — the flag lowers a confidence label and still returns the date.
 *
 * So the gate is a module now rather than a passage of code inside one caller.
 * A route that wants a date has to come through here to get one; there is no
 * second path that produces `SafeDeadline` values, and nothing downstream is
 * given a raw `DeadlineResult` to be tempted by.
 *
 * A warning printed under an unreviewed date is not a substitute for any of
 * this. People act on the date.
 */

export type DeadlineSource = 'PRINTED_ON_NOTICE' | 'CALCULATED_BY_PCNWATCH';

/** A date that may be shown, and may drive what the product says. */
export interface SafeDeadline {
  readonly label: string;
  readonly date: string;
  readonly source: DeadlineSource;
  readonly basis: string;
  readonly confidence: string;
  readonly warnings: readonly string[];
}

/** A date we will not give, and the reason, named so the user knows which. */
export interface RefusedDeadline {
  readonly label: string;
  readonly reason: string;
  readonly message: string;
}

/**
 * Whether a window is open, closed, or not something we can speak to.
 *
 * UNKNOWN is the important member. It is what the product must say when the
 * only thing it could work the answer out from is an unreviewed rule — not
 * "passed", which is a claim, and not "open", which is a different claim.
 */
export type WindowStatus = 'OPEN' | 'PASSED' | 'UNKNOWN';

export interface DeadlineProjection {
  /** Dates copied from the notice. The user confirmed these; we did not compute them. */
  readonly printed: readonly SafeDeadline[];
  /** Dates we calculated from rules a qualified person has signed off. */
  readonly calculated: readonly SafeDeadline[];
  /** Everything we could not, or would not, give — each with its reason. */
  readonly refused: readonly RefusedDeadline[];
  /**
   * Whether the discount period has passed, when that can be established from a
   * printed date or a reviewed rule. UNKNOWN otherwise, and UNKNOWN must not be
   * rendered as either answer.
   */
  readonly discountStatus: WindowStatus;
  /** The date `discountStatus` was decided from, for display. Null when UNKNOWN. */
  readonly discountDecidedFrom: SafeDeadline | null;
}

export interface ProjectionInput {
  /** Confirmed date the notice was served. Calculated dates need it. */
  readonly pcnServedDate?: string;
  readonly noticeToOwnerServedDate?: string;
  readonly noticeOfRejectionServedDate?: string;
  readonly serviceMethod?: ServiceMethod;
  readonly verifiedDates?: {
    readonly pcnServedDate?: boolean;
    readonly noticeToOwnerServedDate?: boolean;
    readonly noticeOfRejectionServedDate?: boolean;
  };
  /** Deadlines printed on the notice and confirmed by the user. */
  readonly printedDeadlines?: {
    readonly discountDeadline?: string;
    readonly representationDeadline?: string;
  };
  /**
   * When false, no calculation is attempted at all — a private parking charge
   * is not governed by these rules and computing against them would be wrong
   * before the question of review even arises.
   */
  readonly calculationApplies?: boolean;
  /** Today, as ISO. Supplied rather than read so the result is deterministic. */
  readonly today?: string;
}

const REFUSAL_MESSAGE =
  'PCNWatch can work this date out, but the timing rule behind it has not yet been checked by a ' +
  'qualified person, so we will not show you a date to act on. Use the deadline printed on your notice.';

export function projectDeadlines(input: ProjectionInput): DeadlineProjection {
  const printed: SafeDeadline[] = [];
  if (input.printedDeadlines?.discountDeadline) {
    printed.push({
      label: 'Discount period ends',
      date: input.printedDeadlines.discountDeadline,
      source: 'PRINTED_ON_NOTICE',
      basis: 'Printed on your notice',
      confidence: 'HIGH',
      warnings: [],
    });
  }
  if (input.printedDeadlines?.representationDeadline) {
    printed.push({
      label: 'Representations due',
      date: input.printedDeadlines.representationDeadline,
      source: 'PRINTED_ON_NOTICE',
      basis: 'Printed on your notice',
      confidence: 'HIGH',
      warnings: [],
    });
  }

  const results: DeadlineResult[] =
    input.calculationApplies === false
      ? []
      : calculateAllDeadlines({
          pcnServedDate: input.pcnServedDate,
          noticeToOwnerServedDate: input.noticeToOwnerServedDate,
          noticeOfRejectionServedDate: input.noticeOfRejectionServedDate,
          serviceMethod: input.serviceMethod,
          verifiedDates: input.verifiedDates,
        });

  const calculated: SafeDeadline[] = [];
  const refused: RefusedDeadline[] = [];

  for (const result of results) {
    const rule = findRule(result.deadlineType);
    // A rule's own name, not the enum. "We do not have the date this deadline
    // runs from" repeated five times told nobody which deadline was missing.
    const label = rule?.label ?? humaniseDeadlineType(result.deadlineType);

    if (!result.calculated) {
      refused.push({
        label,
        reason: result.reason,
        message: `${label}: ${lowerFirst(result.message)}`,
      });
      continue;
    }

    if (rule && rule.reviewStatus !== 'REVIEWED') {
      // The date exists and is not going anywhere near the caller.
      refused.push({ label, reason: 'RULE_AWAITING_REVIEW', message: `${label}: ${REFUSAL_MESSAGE}` });
      continue;
    }

    calculated.push({
      label,
      date: result.calculatedDueDate,
      source: 'CALCULATED_BY_PCNWATCH',
      basis: result.triggerDescription,
      confidence: result.confidence,
      warnings: result.warnings,
    });
  }

  return {
    printed,
    calculated,
    refused,
    ...discountWindow(printed, calculated, input.today),
  };
}

/**
 * Whether the discount period has passed.
 *
 * Decided only from a date that survived the gate above — which is the whole
 * point. A saved case was telling users "The discount period appears to have
 * passed, so the full amount is shown" on the strength of an unreviewed
 * calculation, quietly removing the reduced figure from a page they were
 * reading to decide whether to pay it. Being unable to say is the correct
 * answer far more often than either alternative, and it costs nothing but a
 * sentence.
 */
function discountWindow(
  printed: readonly SafeDeadline[],
  calculated: readonly SafeDeadline[],
  today: string | undefined,
): Pick<DeadlineProjection, 'discountStatus' | 'discountDecidedFrom'> {
  if (!today) return { discountStatus: 'UNKNOWN', discountDecidedFrom: null };

  // The printed date wins where there is one: the user read it off their own
  // notice, which beats anything we would derive.
  const source =
    printed.find((d) => d.label === 'Discount period ends') ??
    calculated.find((d) => d.label === 'Discounted amount deadline') ??
    null;

  if (!source) return { discountStatus: 'UNKNOWN', discountDecidedFrom: null };
  return {
    discountStatus: source.date >= today ? 'OPEN' : 'PASSED',
    discountDecidedFrom: source,
  };
}

function humaniseDeadlineType(type: DeadlineType): string {
  return type
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
