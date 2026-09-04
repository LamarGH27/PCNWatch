/**
 * Deadline rules for London local-authority PCNs.
 *
 * IMPORTANT — these are *encoded* rules, not legal advice, and every one carries a
 * citation plus a `reviewStatus`. A rule with `reviewStatus: 'PENDING_LEGAL_REVIEW'`
 * must never drive a HIGH-confidence deadline in production: `requireReviewedRules`
 * in the calculator downgrades or refuses accordingly.
 *
 * Nothing in this file may be invented by a model. Adding a rule requires a real
 * `sourceName` + `sourceLocation` that a reviewer can check.
 */

import type { DeadlineType, ServiceMethod } from './types';

export type ReviewStatus = 'REVIEWED' | 'PENDING_LEGAL_REVIEW';

export interface DeadlineRule {
  readonly key: string;
  readonly version: number;
  readonly deadlineType: DeadlineType;
  readonly label: string;
  readonly jurisdiction: 'ENGLAND_LONDON';
  /** Days added to the trigger date. */
  readonly days: number;
  readonly triggerDescription: string;
  readonly sourceName: string;
  readonly sourceLocation: string;
  readonly reviewStatus: ReviewStatus;
  readonly reviewedAt: string | null;
  readonly notes: string;
}

/** Rule identifier including version, e.g. "LDN-DISCOUNT-14D@1". */
export function ruleId(rule: DeadlineRule): string {
  return `${rule.key}@${rule.version}`;
}

export const DEADLINE_RULES: readonly DeadlineRule[] = [
  {
    key: 'LDN-DISCOUNT-14D',
    version: 1,
    deadlineType: 'DISCOUNT_EXPIRY',
    label: 'Discounted amount deadline',
    jurisdiction: 'ENGLAND_LONDON',
    days: 14,
    triggerDescription: 'Date the penalty charge notice was served',
    sourceName: 'Traffic Management Act 2004, Part 6 (civil enforcement of road traffic contraventions)',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/part/6',
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    reviewedAt: null,
    notes:
      'A reduced amount is payable when payment is made within the statutory discount period. ' +
      'Authorities may extend the discount after rejecting an informal challenge; that extension ' +
      'is authority-specific and is not applied automatically.',
  },
  {
    key: 'LDN-FORMAL-REPS-28D',
    version: 1,
    deadlineType: 'FORMAL_REPRESENTATION_DEADLINE',
    label: 'Formal representations deadline',
    jurisdiction: 'ENGLAND_LONDON',
    days: 28,
    triggerDescription: 'Date the Notice to Owner was served',
    sourceName: 'Traffic Management Act 2004, Part 6 / Notice to Owner representations period',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/part/6',
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    reviewedAt: null,
    notes: 'Formal representations to the enforcement authority follow service of the Notice to Owner.',
  },
  {
    key: 'LDN-TRIBUNAL-APPEAL-28D',
    version: 1,
    deadlineType: 'TRIBUNAL_APPEAL_DEADLINE',
    label: 'Tribunal appeal deadline',
    jurisdiction: 'ENGLAND_LONDON',
    days: 28,
    triggerDescription: 'Date the Notice of Rejection was served',
    sourceName: 'London Tribunals — Environment and Traffic Adjudicators, appeal process',
    sourceLocation: 'https://www.londontribunals.gov.uk/',
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    reviewedAt: null,
    notes: 'Appeal to the independent adjudicator following rejection of formal representations.',
  },
  {
    key: 'LDN-CHARGE-CERT-28D',
    version: 1,
    deadlineType: 'CHARGE_CERTIFICATE_RISK',
    label: 'Charge Certificate risk date',
    jurisdiction: 'ENGLAND_LONDON',
    days: 28,
    triggerDescription: 'Date the Notice to Owner was served',
    sourceName: 'Traffic Management Act 2004, Part 6 — charge certificates',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/part/6',
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    reviewedAt: null,
    notes:
      'Indicative date after which an authority may issue a Charge Certificate increasing the penalty. ' +
      'Presented as a risk indicator, not as a guaranteed date.',
  },
  {
    key: 'LDN-FULL-AMOUNT-28D',
    version: 1,
    deadlineType: 'FULL_AMOUNT_DUE',
    label: 'Full amount payable by',
    jurisdiction: 'ENGLAND_LONDON',
    days: 28,
    triggerDescription: 'Date the penalty charge notice was served',
    sourceName: 'Traffic Management Act 2004, Part 6',
    sourceLocation: 'https://www.legislation.gov.uk/ukpga/2004/18/part/6',
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    reviewedAt: null,
    notes: 'Period during which the full penalty is payable before further escalation.',
  },
];

export function findRule(deadlineType: DeadlineType): DeadlineRule | undefined {
  return DEADLINE_RULES.find((r) => r.deadlineType === deadlineType);
}

/**
 * Deemed-service offset in *working days* for posted notices.
 *
 * Applied only when the user tells us the notice arrived by post and we know the
 * posting date rather than the service date. When neither is known we refuse to
 * calculate rather than guess.
 */
export const POSTED_DEEMED_SERVICE_WORKING_DAYS = 2;

export function serviceMethodNeedsDeemedService(method: ServiceMethod): boolean {
  return method === 'POSTED';
}
