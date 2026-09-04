export type DeadlineType =
  | 'DISCOUNT_EXPIRY'
  | 'FULL_AMOUNT_DUE'
  | 'INFORMAL_CHALLENGE_WINDOW'
  | 'FORMAL_REPRESENTATION_DEADLINE'
  | 'TRIBUNAL_APPEAL_DEADLINE'
  | 'CHARGE_CERTIFICATE_RISK';

export type DeadlineConfidence = 'HIGH' | 'MEDIUM' | 'LOW';

export type ServiceMethod = 'AFFIXED_TO_VEHICLE' | 'HANDED_TO_DRIVER' | 'POSTED';

export interface CalculatedDeadline {
  readonly deadlineType: DeadlineType;
  readonly label: string;
  readonly triggerDate: string;
  readonly triggerDescription: string;
  readonly calculatedDueDate: string;
  /** Machine-readable identifier of the rule used, e.g. "TMA2004-LDN-DISCOUNT-14D@1". */
  readonly calculationRule: string;
  readonly confidence: DeadlineConfidence;
  /** True when the underlying trigger date has been confirmed by the user. */
  readonly userVerified: boolean;
  /** Shown to the user whenever confidence is not HIGH. */
  readonly warnings: readonly string[];
  /** Reference record key that authorises this rule. Never empty. */
  readonly referenceKey: string;
}

export interface DeadlineRefusal {
  readonly deadlineType: DeadlineType;
  readonly calculated: false;
  readonly reason: string;
  readonly message: string;
}

export type DeadlineResult =
  | (CalculatedDeadline & { readonly calculated: true })
  | DeadlineRefusal;
