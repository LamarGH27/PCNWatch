import { evidenceForAssertion, isMitigationAssertion } from './questions';
import { reconcileContext } from './reconcile';
import type { CanonicalFact } from './reconcile';
import { evidenceRelevance, isIndependentEvidence } from './reconcile';
import type {
  ConfirmedAssertion,
  NarrativeAssertion,
  NarrativeAssertionKind,
} from './types';
import { ASSERTION_LABELS } from './types';
import { EVIDENCE_DEFINITIONS } from '../evidence/definitions';
import type { EvidenceType } from '../evidence/types';

/**
 * How much of what we read back has to be confirmed before it counts.
 *
 * The old journey showed the user every assertion the reader returned and asked
 * about each one. That is the safest possible design and it is also the reason
 * people gave up: a person who has just typed three sentences about their
 * parking ticket is asked six questions about the three sentences they typed.
 *
 * So this decides, deterministically, which readings a person genuinely has to
 * look at and which can be accepted and simply shown back. The rule mirrors the
 * one already used for notice fields — low confidence, or on a list of things
 * too consequential to accept quietly — because the same reasoning applies and
 * having two different rules would mean having two different standards.
 *
 * Nothing here decides what a fact *means*. It decides who has to look at it.
 */

/** Mirrors FIELD_VERIFICATION_THRESHOLD, and for the same reason. */
export const NARRATIVE_AUTO_ACCEPT_THRESHOLD = 0.85;

/**
 * Readings a person always checks, however confident the reader was.
 *
 * These are claims that somebody held an entitlement. They are the assertions
 * that end up in a letter as "I held a valid resident permit", and a letter
 * making that claim wrongly is worse for the user than no letter at all — it
 * is the one mistake an authority can disprove outright.
 *
 * `OTHER_REQUIRES_REVIEW` is here because it means the reader could not fit
 * what the user said into any category, which is precisely when a person
 * should look.
 */
export const ALWAYS_CONFIRM_ASSERTIONS: readonly NarrativeAssertionKind[] = [
  'HELD_PERMIT',
  'PERMIT_VALID',
  'BLUE_BADGE_PRESENT',
  'OTHER_REQUIRES_REVIEW',
];

export type ConfirmReason =
  | 'LOW_CONFIDENCE'
  | 'UNCLEAR_STANCE'
  | 'MATERIAL_CLAIM'
  | 'CONFLICTS_WITH_ANSWER';

export const CONFIRM_REASON_LABELS: Record<ConfirmReason, string> = {
  LOW_CONFIDENCE: 'We are not certain we read this correctly.',
  UNCLEAR_STANCE: 'You raised this but left it open.',
  MATERIAL_CLAIM: 'This is a claim about a document, so it is worth checking.',
  CONFLICTS_WITH_ANSWER: 'This does not match something else you told us.',
};

export interface TriagedAssertion {
  readonly assertion: NarrativeAssertion;
  readonly label: string;
  readonly reason: ConfirmReason | null;
}

export interface NarrativeTriage {
  /** Accepted without asking. Shown back compactly, with an edit route. */
  readonly accepted: readonly TriagedAssertion[];
  /** The user has to look at these before they count. */
  readonly mustConfirm: readonly TriagedAssertion[];
}

/**
 * Splits what the reader returned into what a person must look at and what
 * can simply be shown back to them.
 *
 * `answers` is passed in so a reading that contradicts something the user
 * already answered is escalated rather than accepted. That case is exactly the
 * one the reconciliation layer was built for, and accepting one side of a
 * contradiction quietly is how the product ends up holding two facts it cannot
 * both be right about.
 */
export function triageNarrative(
  extracted: readonly NarrativeAssertion[],
  answers: readonly { questionId: string; answer: string }[] = [],
): NarrativeTriage {
  const conflicted = new Set(
    reconcileContext(
      answers as never,
      extracted.map((a) => ({ kind: a.kind, stance: a.stance })) as readonly ConfirmedAssertion[],
      [],
    ).conflicts.map((c) => c.topic),
  );

  const accepted: TriagedAssertion[] = [];
  const mustConfirm: TriagedAssertion[] = [];

  for (const assertion of extracted) {
    const label = ASSERTION_LABELS[assertion.kind] ?? assertion.kind;
    const reason = confirmReasonFor(assertion, conflicted);
    if (reason === null) accepted.push({ assertion, label, reason: null });
    else mustConfirm.push({ assertion, label, reason });
  }

  return { accepted, mustConfirm };
}

function confirmReasonFor(
  assertion: NarrativeAssertion,
  conflicted: ReadonlySet<NarrativeAssertionKind>,
): ConfirmReason | null {
  if (conflicted.has(assertion.kind)) return 'CONFLICTS_WITH_ANSWER';
  if (ALWAYS_CONFIRM_ASSERTIONS.includes(assertion.kind)) return 'MATERIAL_CLAIM';
  // "They raise it but leave it open" is the reader telling us it does not
  // know, which is not something to accept on the reader's behalf.
  if (assertion.stance === 'UNCLEAR') return 'UNCLEAR_STANCE';
  if (assertion.confidence < NARRATIVE_AUTO_ACCEPT_THRESHOLD) return 'LOW_CONFIDENCE';
  return null;
}

/**
 * What accepting the triage produces, in the shape the engine already takes.
 *
 * Kind and stance only, exactly as the confirmation screen produced. An
 * accepted reading and a hand-confirmed one are indistinguishable downstream,
 * which is the point: nothing later has to know, or could act on, how a fact
 * came to be confirmed.
 */
export function acceptedAssertions(triage: NarrativeTriage): ConfirmedAssertion[] {
  return triage.accepted.map(({ assertion }) => ({
    kind: assertion.kind,
    stance: assertion.stance,
  }));
}

/* ------------------------------------------------------------------ */

/**
 * The one to three questions worth interrupting somebody for.
 *
 * The old journey asked everything the reference store could justify asking.
 * This asks for the evidence that would corroborate what the user has just
 * told us, most relevant first, and stops at three.
 *
 * "I paid with RingGo but selected my old registration" produces "Do you still
 * have the RingGo session showing the payment?" — because the account asserts a
 * payment by app, the assertion maps to a parking app receipt, and the ranking
 * layer puts that first. None of that is new machinery; it is the existing
 * mapping and the existing ranking, asked to stop early.
 */
export const MAX_FOLLOW_UPS = 3;

export interface FollowUp {
  readonly type: EvidenceType;
  readonly prompt: string;
  /** Why this one, in the user's terms. Null when it is simply standard. */
  readonly reason: string | null;
}

export interface FollowUpInput {
  /** Facts the user has confirmed or we have accepted. */
  readonly facts: readonly CanonicalFact[];
  /** Evidence types the user has already told us about. Never asked twice. */
  readonly declared?: readonly EvidenceType[];
  /** Evidence already uploaded. Never asked for what we hold. */
  readonly held?: readonly EvidenceType[];
}

/**
 * Evidence that cannot exist, given what the account says.
 *
 * "I paid using an app" means there is no pay-and-display ticket for that
 * session — not that one is less likely, that there is not one. Several
 * assertions can implicate the same document, so this is keyed on the evidence
 * rather than on the assertion that reached it: WRONG_VRM_POSSIBLE also points
 * at a paper ticket, and the ticket still does not exist.
 *
 * The same shape as SUPERSEDED_BY in reconcile.ts, which decides what is less
 * likely to be the point. This decides what is not worth a question at all,
 * because three questions is the whole budget and one spent on something the
 * user cannot produce is a question wasted.
 *
 * Nothing the authority holds can appear here. A user's account may decide what
 * is relevant to ask them for; it may not remove the authority's own material
 * from the picture, and `isIndependentEvidence` is asserted below rather than
 * left as an understanding.
 */
const NOT_APPLICABLE_WHEN: Partial<Record<EvidenceType, readonly NarrativeAssertionKind[]>> = {
  PAYMENT_RECEIPT: ['PAYMENT_BY_APP'],
};

export function selectFollowUps(input: FollowUpInput): readonly FollowUp[] {
  const asked = new Set<EvidenceType>([...(input.declared ?? []), ...(input.held ?? [])]);
  const asserted = new Set(
    input.facts.filter((fact) => fact.stance === 'ASSERTED').map((fact) => fact.topic),
  );

  /*
   * Only what the user's own account implicates.
   *
   * Deliberately not the full requirement list for the contravention: that is
   * the evidence checklist, it belongs on the strengthening step, and putting
   * it in front of somebody before they have an assessment is what made the old
   * journey feel like a form. A follow-up earns its place by being about
   * something they just said.
   */
  const candidates: EvidenceType[] = [];
  for (const fact of input.facts) {
    if (fact.stance !== 'ASSERTED') continue;
    if (isMitigationAssertion(fact.topic)) continue;
    for (const type of evidenceForAssertion(fact.topic)) {
      if (asked.has(type)) continue;
      if (candidates.includes(type)) continue;
      if (notApplicable(type, asserted)) continue;
      candidates.push(type);
    }
  }

  const priorityOrder = { PRIORITY: 0, STANDARD: 1, LESS_LIKELY: 2 } as const;

  return candidates
    .map((type) => {
      const supports = input.facts
        .map((fact) => fact.topic)
        .filter((topic) => evidenceForAssertion(topic).includes(type));
      const { priority, reason } = evidenceRelevance(type, supports, input.facts);
      return { type, priority, reason };
    })
    .sort((a, b) => {
      const byPriority = priorityOrder[a.priority] - priorityOrder[b.priority];
      // Stable within a band, so the questions do not shuffle between renders.
      return byPriority !== 0 ? byPriority : candidates.indexOf(a.type) - candidates.indexOf(b.type);
    })
    .slice(0, MAX_FOLLOW_UPS)
    .map(({ type, reason }) => ({
      type,
      prompt: followUpPrompt(type),
      reason,
    }));
}

/**
 * The question, in the words somebody would actually use.
 *
 * "Do you still have …" rather than the checklist's "Payment receipt", because
 * this is a question being asked of a person rather than a row in a list of
 * requirements.
 */
/**
 * Whether the account rules this document out.
 *
 * Never for evidence the authority holds. A user saying the contravention did
 * not happen cannot make the authority's photographs inapplicable, and the one
 * place that could go wrong is here, so it is a condition rather than a
 * convention.
 */
function notApplicable(
  type: EvidenceType,
  asserted: ReadonlySet<NarrativeAssertionKind>,
): boolean {
  if (isIndependentEvidence(type)) return false;
  return (NOT_APPLICABLE_WHEN[type] ?? []).some((kind) => asserted.has(kind));
}

function followUpPrompt(type: EvidenceType): string {
  const label = EVIDENCE_DEFINITIONS[type]?.label ?? type;
  return `Do you still have ${lowerFirst(label)}?`;
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
