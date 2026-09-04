import { addDays, dayOfWeek, isIsoDate, type IsoDate } from './date-utils';
import {
  DEADLINE_RULES,
  POSTED_DEEMED_SERVICE_WORKING_DAYS,
  findRule,
  ruleId,
  serviceMethodNeedsDeemedService,
  type DeadlineRule,
} from './rules';
import type { DeadlineResult, DeadlineType, ServiceMethod } from './types';

/**
 * Deadline calculation is deterministic and rule-driven. A model is never asked
 * to compute a legal date, and a missing or unverified trigger date produces a
 * refusal or a warning — never a plausible-looking guess.
 */

export interface DeadlineInput {
  /** Date the PCN itself was served/issued, if known. */
  readonly pcnServedDate?: string;
  /** Date the Notice to Owner was served, if known. */
  readonly noticeToOwnerServedDate?: string;
  /** Date the Notice of Rejection was served, if known. */
  readonly noticeOfRejectionServedDate?: string;
  /** How the notice reached the user; drives deemed-service handling. */
  readonly serviceMethod?: ServiceMethod;
  /** Set only for posted notices where the user knows the posting date, not service. */
  readonly postedDate?: string;
  /** Which trigger dates the user has explicitly confirmed. */
  readonly verifiedDates?: Partial<Record<TriggerKey, boolean>>;
  /**
   * When true (the production default), rules still awaiting legal sign-off
   * cannot produce a HIGH-confidence deadline.
   */
  readonly requireReviewedRules?: boolean;
}

export type TriggerKey = 'pcnServedDate' | 'noticeToOwnerServedDate' | 'noticeOfRejectionServedDate';

const TRIGGER_FOR_TYPE: Record<DeadlineType, TriggerKey> = {
  DISCOUNT_EXPIRY: 'pcnServedDate',
  FULL_AMOUNT_DUE: 'pcnServedDate',
  INFORMAL_CHALLENGE_WINDOW: 'pcnServedDate',
  FORMAL_REPRESENTATION_DEADLINE: 'noticeToOwnerServedDate',
  TRIBUNAL_APPEAL_DEADLINE: 'noticeOfRejectionServedDate',
  CHARGE_CERTIFICATE_RISK: 'noticeToOwnerServedDate',
};

/** Adds `n` working days (Mon–Fri), ignoring public holidays. */
export function addWorkingDays(date: IsoDate, n: number): IsoDate {
  let current = date;
  let remaining = n;
  while (remaining > 0) {
    current = addDays(current, 1);
    const dow = dayOfWeek(current);
    if (dow !== 0 && dow !== 6) remaining -= 1;
  }
  return current;
}

interface ResolvedTrigger {
  readonly date: IsoDate;
  readonly verified: boolean;
  readonly warnings: string[];
  readonly derived: boolean;
}

function resolveTrigger(
  key: TriggerKey,
  input: DeadlineInput,
): ResolvedTrigger | { error: string; message: string } {
  const direct = input[key];
  const verified = input.verifiedDates?.[key] === true;

  if (direct && isIsoDate(direct)) {
    const warnings: string[] = [];
    if (!verified) {
      warnings.push('This date has not been confirmed by you yet — check it against your notice.');
    }
    return { date: direct, verified, warnings, derived: false };
  }

  // Only the PCN service date can be derived, and only from a known posting date.
  if (
    key === 'pcnServedDate' &&
    input.postedDate &&
    isIsoDate(input.postedDate) &&
    input.serviceMethod &&
    serviceMethodNeedsDeemedService(input.serviceMethod)
  ) {
    const derivedDate = addWorkingDays(input.postedDate, POSTED_DEEMED_SERVICE_WORKING_DAYS);
    return {
      date: derivedDate,
      verified: false,
      derived: true,
      warnings: [
        `Service date estimated as ${POSTED_DEEMED_SERVICE_WORKING_DAYS} working days after posting (${input.postedDate}). Public holidays are not accounted for. Confirm the date shown on your notice.`,
      ],
    };
  }

  if (direct && !isIsoDate(direct)) {
    return {
      error: 'INVALID_TRIGGER_DATE',
      message: `The date provided for this deadline is not a valid calendar date (${direct}).`,
    };
  }

  return {
    error: 'MISSING_TRIGGER_DATE',
    message: 'We do not have the date this deadline runs from, so we will not estimate it.',
  };
}

function confidenceFor(
  rule: DeadlineRule,
  trigger: ResolvedTrigger,
  requireReviewedRules: boolean,
): 'HIGH' | 'MEDIUM' | 'LOW' {
  const ruleUnreviewed = rule.reviewStatus !== 'REVIEWED';
  if (ruleUnreviewed && requireReviewedRules) return trigger.derived ? 'LOW' : 'MEDIUM';
  if (trigger.derived) return 'MEDIUM';
  return trigger.verified ? 'HIGH' : 'MEDIUM';
}

export function calculateDeadline(
  deadlineType: DeadlineType,
  input: DeadlineInput,
): DeadlineResult {
  const rule = findRule(deadlineType);
  if (!rule) {
    return {
      deadlineType,
      calculated: false,
      reason: 'NO_APPROVED_RULE',
      message: 'No approved rule exists for this deadline, so FineRadar will not estimate it.',
    };
  }

  const triggerKey = TRIGGER_FOR_TYPE[deadlineType];
  const trigger = resolveTrigger(triggerKey, input);
  if ('error' in trigger) {
    return { deadlineType, calculated: false, reason: trigger.error, message: trigger.message };
  }

  const requireReviewedRules = input.requireReviewedRules ?? true;
  const warnings = [...trigger.warnings];
  if (rule.reviewStatus !== 'REVIEWED') {
    warnings.push(
      'This timing rule is awaiting review by a qualified person. Always check the deadline printed on your notice.',
    );
  }

  return {
    calculated: true,
    deadlineType,
    label: rule.label,
    triggerDate: trigger.date,
    triggerDescription: rule.triggerDescription,
    calculatedDueDate: addDays(trigger.date, rule.days),
    calculationRule: ruleId(rule),
    confidence: confidenceFor(rule, trigger, requireReviewedRules),
    userVerified: trigger.verified,
    warnings,
    referenceKey: rule.key,
  };
}

/** Calculates every deadline the available dates support. Refusals are included. */
export function calculateAllDeadlines(input: DeadlineInput): DeadlineResult[] {
  const types = Array.from(new Set(DEADLINE_RULES.map((r) => r.deadlineType)));
  return types.map((t) => calculateDeadline(t, input));
}
