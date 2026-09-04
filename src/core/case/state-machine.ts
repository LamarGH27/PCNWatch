import type { ProceduralStage } from '../reference/types';

/**
 * PCN case state machine.
 *
 * Transitions are explicit. A stage is never inferred from a document unless the
 * classifier is confident AND the user has verified the fields that justify it —
 * otherwise the case sits in UNKNOWN_STAGE and asks the user, which is the safe
 * failure mode.
 */

export const PROCEDURAL_STAGES = [
  'NEW',
  'INFORMAL_CHALLENGE',
  'NOTICE_TO_OWNER',
  'FORMAL_REPRESENTATION',
  'NOTICE_OF_ACCEPTANCE',
  'NOTICE_OF_REJECTION',
  'TRIBUNAL_ELIGIBLE',
  'TRIBUNAL_APPEAL',
  'CLOSED_WON',
  'CLOSED_PAID',
  'CLOSED_LOST',
  'UNKNOWN_STAGE',
] as const satisfies readonly ProceduralStage[];

export const TERMINAL_STAGES: readonly ProceduralStage[] = [
  'CLOSED_WON',
  'CLOSED_PAID',
  'CLOSED_LOST',
];

const TRANSITIONS: Record<ProceduralStage, readonly ProceduralStage[]> = {
  NEW: ['INFORMAL_CHALLENGE', 'NOTICE_TO_OWNER', 'CLOSED_PAID', 'UNKNOWN_STAGE'],
  INFORMAL_CHALLENGE: ['NOTICE_TO_OWNER', 'CLOSED_WON', 'CLOSED_PAID', 'UNKNOWN_STAGE'],
  NOTICE_TO_OWNER: ['FORMAL_REPRESENTATION', 'CLOSED_PAID', 'UNKNOWN_STAGE'],
  FORMAL_REPRESENTATION: [
    'NOTICE_OF_ACCEPTANCE',
    'NOTICE_OF_REJECTION',
    'CLOSED_PAID',
    'UNKNOWN_STAGE',
  ],
  NOTICE_OF_ACCEPTANCE: ['CLOSED_WON', 'UNKNOWN_STAGE'],
  NOTICE_OF_REJECTION: ['TRIBUNAL_ELIGIBLE', 'CLOSED_PAID', 'CLOSED_LOST', 'UNKNOWN_STAGE'],
  TRIBUNAL_ELIGIBLE: ['TRIBUNAL_APPEAL', 'CLOSED_PAID', 'CLOSED_LOST', 'UNKNOWN_STAGE'],
  TRIBUNAL_APPEAL: ['CLOSED_WON', 'CLOSED_LOST', 'CLOSED_PAID', 'UNKNOWN_STAGE'],
  CLOSED_WON: [],
  CLOSED_PAID: [],
  CLOSED_LOST: [],
  // A case can be rescued from UNKNOWN_STAGE to any non-terminal stage once the
  // user tells us where they actually are.
  UNKNOWN_STAGE: [
    'NEW',
    'INFORMAL_CHALLENGE',
    'NOTICE_TO_OWNER',
    'FORMAL_REPRESENTATION',
    'NOTICE_OF_ACCEPTANCE',
    'NOTICE_OF_REJECTION',
    'TRIBUNAL_ELIGIBLE',
    'TRIBUNAL_APPEAL',
    'CLOSED_WON',
    'CLOSED_PAID',
    'CLOSED_LOST',
  ],
};

export function isTerminal(stage: ProceduralStage): boolean {
  return TERMINAL_STAGES.includes(stage);
}

export function canTransition(from: ProceduralStage, to: ProceduralStage): boolean {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export type TransitionActor = 'USER' | 'DOCUMENT_VERIFIED' | 'SYSTEM';

export interface TransitionRequest {
  readonly from: ProceduralStage;
  readonly to: ProceduralStage;
  readonly actor: TransitionActor;
  /** Extraction/classification confidence, 0-1, when driven by a document. */
  readonly confidence?: number;
  /** Whether the user has confirmed the fields that justify the change. */
  readonly userVerified?: boolean;
}

export type TransitionOutcome =
  | { readonly allowed: true; readonly stage: ProceduralStage }
  | { readonly allowed: false; readonly stage: ProceduralStage; readonly reason: string };

/** A document-driven transition needs at least this classification confidence. */
export const DOCUMENT_TRANSITION_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Decides whether a stage change may be applied.
 *
 * Deliberately conservative: a document-driven change to a stage that shortens a
 * user's remaining options is only applied when the classifier is confident *and*
 * the user has verified it. Anything else leaves the case where it is.
 */
export function requestTransition(request: TransitionRequest): TransitionOutcome {
  const { from, to, actor, confidence, userVerified } = request;

  if (isTerminal(from) && from !== to) {
    return { allowed: false, stage: from, reason: 'This case is closed and its stage cannot change.' };
  }
  if (!canTransition(from, to)) {
    return {
      allowed: false,
      stage: from,
      reason: `A case cannot move directly from ${from} to ${to}.`,
    };
  }
  if (actor === 'DOCUMENT_VERIFIED') {
    if (userVerified !== true) {
      return {
        allowed: false,
        stage: from,
        reason: 'The details taken from this document have not been confirmed by you yet.',
      };
    }
    if ((confidence ?? 0) < DOCUMENT_TRANSITION_CONFIDENCE_THRESHOLD) {
      return {
        allowed: false,
        stage: from,
        reason: 'We could not read this document confidently enough to change the case stage.',
      };
    }
  }
  return { allowed: true, stage: to };
}

export const STAGE_LABELS: Record<ProceduralStage, string> = {
  NEW: 'Notice received',
  INFORMAL_CHALLENGE: 'Informal challenge sent',
  NOTICE_TO_OWNER: 'Notice to Owner received',
  FORMAL_REPRESENTATION: 'Formal representations sent',
  NOTICE_OF_ACCEPTANCE: 'Representations accepted',
  NOTICE_OF_REJECTION: 'Representations rejected',
  TRIBUNAL_ELIGIBLE: 'Eligible to appeal',
  TRIBUNAL_APPEAL: 'Appeal submitted',
  CLOSED_WON: 'Closed — cancelled',
  CLOSED_PAID: 'Closed — paid',
  CLOSED_LOST: 'Closed — unsuccessful',
  UNKNOWN_STAGE: 'Stage not confirmed',
};
