import { getReference } from '../reference/store';
import { resolveQuestionPrompt } from './questions';
import {
  ASSERTION_LABELS as ASSERTION_LABEL_FOR,
  isDefiniteAnswer,
  type AnswerValue,
  type ConfirmedAssertion,
  type ContextAnswer,
  type NarrativeAssertionKind,
  type NarrativeStance,
  type ResolvedFact,
} from './types';

/**
 * Reconciling what the user told us twice.
 *
 * PCNWatch asks the same facts in two ways. It puts structured questions to the
 * user, and it reads their written account. Until this module existed those two
 * were composed into two separate findings that never saw each other, and a
 * real assessment displayed both of these at once:
 *
 *     "Did you buy a pay-and-display ticket or pay by app instead? — no."
 *     "you paid to park; you paid using an app"
 *
 * Both were true records of something the user had said. Neither was wrong on
 * its own. What was wrong was showing them side by side as though they were
 * consistent, leaving a person to notice for themselves that their own case
 * file contradicted itself — and leaving PCNWatch with no idea which fact it
 * was reasoning about.
 *
 * The fix is a shared vocabulary. A question and an assertion that are about
 * the same thing are mapped to the same topic, and after that "did they pay?"
 * has one answer or an unresolved disagreement, never two answers.
 */

/**
 * The thing a claim is about.
 *
 * The assertion vocabulary is reused rather than a third one invented: it is
 * already the closed set of factual claims this product recognises, and adding
 * a parallel list would be one more place for the same fact to be named
 * differently.
 */
export type FactTopic = NarrativeAssertionKind;

export type FactStance = NarrativeStance;

/** Where a canonical fact came from. Kept internally; not shown as a label. */
export type FactProvenance = 'QUESTION_RESPONSE' | 'USER_ACCOUNT' | 'BOTH';

export interface CanonicalFact {
  readonly topic: FactTopic;
  readonly stance: FactStance;
  readonly provenance: FactProvenance;
}

export interface FactConflict {
  readonly topic: FactTopic;
  /** The question, in the reference store's own words. */
  readonly questionPrompt: string;
  readonly questionId: string;
  readonly questionAnswer: AnswerValue;
  /** What the two sources say, already translated into stances. */
  readonly fromQuestion: FactStance;
  readonly fromAccount: FactStance;
}

export interface ReconciledContext {
  /** One entry per topic. Never two rows about the same fact. */
  readonly facts: readonly CanonicalFact[];
  /** Topics where the two sources disagree and the user has not chosen. */
  readonly conflicts: readonly FactConflict[];
  /**
   * Answers that are not about any topic we can reconcile.
   *
   * Reported so they can still be shown, and counted so an assessment does not
   * claim the user told us nothing when they answered four questions we have no
   * mapping for.
   */
  readonly unmappedAnswers: readonly ContextAnswer[];
}

/**
 * How a question's answer translates into a claim about a topic.
 *
 * `expectedPrompt` is the safety mechanism. Question ids are positional —
 * `CONTRAVENTION-12#3` means "the fourth question in that record" — so
 * reordering the reference list would silently re-point every mapping at a
 * different question. Each entry therefore records the wording it was written
 * against, and a mapping whose wording no longer matches is ignored at runtime
 * rather than applied to a question it was not written for. A test fails on
 * the mismatch, so drift is caught before it ships; if one ever slipped
 * through, the cost is a conflict we fail to notice, not a conflict we invent
 * about the wrong question.
 */
interface QuestionMapping {
  readonly questionId: string;
  readonly expectedPrompt: string;
  readonly topic: FactTopic;
  /**
   * INVERTED means yes-to-the-question is a denial of the topic. "Was the
   * correct registration linked to it?" answered yes means the wrong
   * registration was *not* entered.
   */
  readonly polarity: 'DIRECT' | 'INVERTED';
}

/**
 * Deliberately short.
 *
 * Only questions whose subject is unambiguous are mapped. "If physical, was it
 * displayed and legible from outside the vehicle?" is about a permit, but a no
 * could mean there was no physical permit at all, so it is left out: a mapping
 * that is right most of the time would produce conflicts that are wrong some of
 * the time, and a spurious "which of these is correct?" is worse than a
 * question we simply do not reconcile.
 *
 * Note the code 12 payment question. It is compound — a pay-and-display ticket
 * OR an app — so it is mapped to whether the user paid at all rather than to
 * how. That is what a "no" to it actually denies. (The compound wording is a
 * separate product problem: it comes from the reference record and asking two
 * things at once is not something this module can fix.)
 */
const QUESTION_MAPPINGS: readonly QuestionMapping[] = [
  {
    questionId: 'CONTRAVENTION-12#0',
    expectedPrompt: 'Did you hold a valid permit for that bay at that time?',
    topic: 'HELD_PERMIT',
    polarity: 'DIRECT',
  },
  {
    questionId: 'CONTRAVENTION-12#1',
    expectedPrompt: 'If the permit is virtual, was the correct registration linked to it?',
    topic: 'WRONG_VRM_POSSIBLE',
    polarity: 'INVERTED',
  },
  {
    questionId: 'CONTRAVENTION-12#3',
    expectedPrompt: 'Did you buy a pay-and-display ticket or pay by app instead?',
    topic: 'PAYMENT_MADE',
    polarity: 'DIRECT',
  },
  {
    questionId: 'CONTRAVENTION-01#2',
    expectedPrompt: 'Were you loading or unloading, and for how long?',
    topic: 'LOADING_OR_UNLOADING',
    polarity: 'DIRECT',
  },
  {
    questionId: 'CONTRAVENTION-02#2',
    expectedPrompt: 'What activity was taking place at the vehicle?',
    topic: 'LOADING_OR_UNLOADING',
    polarity: 'DIRECT',
  },
  {
    questionId: 'GENERAL#council-photographs',
    expectedPrompt: 'Have you looked at the photographs the authority took?',
    topic: 'AUTHORITY_PHOTOGRAPHS_REVIEWED',
    polarity: 'DIRECT',
  },
  {
    questionId: 'GENERAL#mitigation',
    expectedPrompt:
      'Was there something exceptional about that day, such as a medical emergency or a vehicle breakdown?',
    topic: 'MITIGATING_CIRCUMSTANCES',
    polarity: 'DIRECT',
  },
];

/** Every mapping, for tests that check the wording still matches the store. */
export function questionMappings(): readonly QuestionMapping[] {
  return QUESTION_MAPPINGS;
}

/** The mapping for a question, or null when there is none or the wording moved. */
export function mappingFor(questionId: string): QuestionMapping | null {
  const mapping = QUESTION_MAPPINGS.find((m) => m.questionId === questionId);
  if (!mapping) return null;
  // The wording check. A reference record that has been reordered or reworded
  // no longer means what this mapping was written against.
  return resolveQuestionPrompt(questionId) === mapping.expectedPrompt ? mapping : null;
}

function stanceFromAnswer(answer: AnswerValue, polarity: 'DIRECT' | 'INVERTED'): FactStance | null {
  if (!isDefiniteAnswer(answer)) {
    // NOT_SURE and UNANSWERED say nothing definite. Crucially they are not
    // treated as denials — an untouched question is not a "no", and that
    // conflation is exactly what makes a contradiction look like a fact.
    return answer === 'NOT_SURE' ? 'UNCLEAR' : null;
  }
  const asserted = answer === 'YES';
  const positive = polarity === 'DIRECT' ? asserted : !asserted;
  return positive ? 'ASSERTED' : 'DENIED';
}

/**
 * Reduces both sources to one set of facts, and reports what would not reduce.
 *
 * A conflict is only raised when both sides are definite and they disagree.
 * Anything softer — a not-sure, an unanswered question, an assertion the reader
 * marked unclear — resolves to the definite side rather than becoming a
 * question for the user, because asking somebody to reconcile "yes" with "I
 * am not certain" is asking them to do a job that has no answer.
 */
export function reconcileContext(
  answers: readonly ContextAnswer[],
  assertions: readonly ConfirmedAssertion[],
  resolutions: readonly ResolvedFact[] = [],
): ReconciledContext {
  const fromQuestions = new Map<FactTopic, { stance: FactStance; answer: ContextAnswer }>();
  const unmappedAnswers: ContextAnswer[] = [];

  for (const answer of answers) {
    if (answer.answer === 'UNANSWERED') continue;
    const mapping = mappingFor(answer.questionId);
    if (!mapping) {
      unmappedAnswers.push(answer);
      continue;
    }
    const stance = stanceFromAnswer(answer.answer, mapping.polarity);
    if (stance === null) continue;
    fromQuestions.set(mapping.topic, { stance, answer });
  }

  const fromAccount = new Map<FactTopic, FactStance>();
  for (const assertion of assertions) fromAccount.set(assertion.kind, assertion.stance);

  // A topic the user has already decided about is settled, whatever either
  // source said originally.
  const resolved = new Map<FactTopic, FactStance>();
  for (const resolution of resolutions) resolved.set(resolution.topic, resolution.stance);

  const facts: CanonicalFact[] = [];
  const conflicts: FactConflict[] = [];

  for (const topic of new Set([...fromQuestions.keys(), ...fromAccount.keys()])) {
    const question = fromQuestions.get(topic);
    const account = fromAccount.get(topic);

    if (resolved.has(topic)) {
      facts.push({
        topic,
        stance: resolved.get(topic) as FactStance,
        provenance: question && account ? 'BOTH' : question ? 'QUESTION_RESPONSE' : 'USER_ACCOUNT',
      });
      continue;
    }

    if (question && account) {
      const bothDefinite = question.stance !== 'UNCLEAR' && account !== 'UNCLEAR';
      if (bothDefinite && question.stance !== account) {
        conflicts.push({
          topic,
          questionId: question.answer.questionId,
          questionPrompt: resolveQuestionPrompt(question.answer.questionId) ?? question.answer.questionId,
          questionAnswer: question.answer.answer,
          fromQuestion: question.stance,
          fromAccount: account,
        });
        // The topic produces no fact at all while it is disputed. A conflicted
        // fact must not reach the assessment in either version, because
        // choosing one silently is the bug this module exists to prevent.
        continue;
      }
      // They agree, or one of them is soft. One fact, marked as corroborated.
      facts.push({
        topic,
        stance: question.stance === 'UNCLEAR' ? account : question.stance,
        provenance: 'BOTH',
      });
      continue;
    }

    if (question) {
      facts.push({ topic, stance: question.stance, provenance: 'QUESTION_RESPONSE' });
      continue;
    }
    facts.push({ topic, stance: account as FactStance, provenance: 'USER_ACCOUNT' });
  }

  return { facts, conflicts, unmappedAnswers };
}

/** True when a question's wording no longer matches what its mapping expected. */
export function mappingIsStale(mapping: QuestionMapping): boolean {
  const record = getReference(mapping.questionId.split('#')[0] as string);
  if (!record && !mapping.questionId.startsWith('GENERAL#')) return true;
  return resolveQuestionPrompt(mapping.questionId) !== mapping.expectedPrompt;
}

/* ------------------------------------------------------------------ */
/* What evidence is worth asking for                                   */
/* ------------------------------------------------------------------ */

/**
 * How prominently to ask for a piece of evidence.
 *
 * Nothing is ever dropped. A real assessment asked a user who had just told us
 * they paid by app to produce a parking permit, at the top of the list, because
 * the list came from the contravention record alone and knew nothing about
 * them. That is the problem being fixed — but the fix is ordering, not
 * deletion: a user who chose "paid by app" from a list of things that might
 * have happened may still have had a permit, and a product that quietly stopped
 * asking would be deciding their case for them.
 */
export type EvidencePriority = 'PRIORITY' | 'STANDARD' | 'LESS_LIKELY';

/**
 * Confirmed facts that make a piece of evidence less likely to be the point.
 *
 * Read as: "if the user asserted this, the evidence above is probably not what
 * their case turns on". A route through the day, not a ruling about it — paying
 * by app is a different way of parking lawfully from holding a permit, so a
 * permit becomes the less likely document, not an impossible one.
 *
 * Only ever applied to evidence the user themselves would produce. Nothing here
 * can reach the authority's own material; see INDEPENDENT_EVIDENCE.
 */
const SUPERSEDED_BY: Partial<Record<string, readonly FactTopic[]>> = {
  PERMIT: ['PAYMENT_MADE', 'PAYMENT_BY_APP'],
  PAYMENT_RECEIPT: ['HELD_PERMIT'],
  PARKING_APP_RECEIPT: ['HELD_PERMIT'],
};

/**
 * Evidence that exists whatever the user says, and can contradict them.
 *
 * This set is the reason the ranking rules below are shaped as they are. An
 * assessment demoted "The authority's photographs" to "less likely to matter
 * here", reasoning "You told us this is not what happened, so it is unlikely to
 * be what your case turns on" — which is exactly backwards. Photographs held by
 * the authority matter *because* they can settle a disputed fact, and they can
 * settle it against the user as easily as for them. A product that quietly
 * buried the one piece of evidence capable of falsifying its user's account
 * would be building them a case out of nothing but their own say-so.
 *
 * So: nothing the user asserts or denies may push anything in this set below
 * STANDARD. Their account can decide what is *most* relevant. It cannot decide
 * what is allowed to contradict them.
 */
const INDEPENDENT_EVIDENCE: ReadonlySet<string> = new Set(['COUNCIL_PHOTOGRAPHS', 'PCN_IMAGE']);

/**
 * Topics that are a dispute about what happened.
 *
 * Excluded: whether the user has got round to looking at the authority's
 * photographs (their progress, not an event), something we could not classify,
 * and mitigation — which asks for discretion rather than denying the
 * contravention.
 */
const NON_FACTUAL_TOPICS: ReadonlySet<FactTopic> = new Set<FactTopic>([
  'AUTHORITY_PHOTOGRAPHS_REVIEWED',
  'OTHER_REQUIRES_REVIEW',
  'MITIGATING_CIRCUMSTANCES',
  'VEHICLE_BROKE_DOWN',
]);

/** True when this evidence may never be demoted by what the user says. */
export function isIndependentEvidence(evidenceType: string): boolean {
  return INDEPENDENT_EVIDENCE.has(evidenceType);
}

export interface EvidenceRelevance {
  readonly priority: EvidencePriority;
  /** Why this sits where it does, in the user's own terms. Null when standard. */
  readonly reason: string | null;
}

/**
 * Where one piece of evidence belongs, given what the user has confirmed.
 *
 * `supports` is the set of topics this evidence would corroborate — passed in
 * rather than derived here so the caller keeps one mapping of evidence to
 * facts rather than two.
 */
export function evidenceRelevance(
  evidenceType: string,
  supports: readonly FactTopic[],
  facts: readonly CanonicalFact[],
): EvidenceRelevance {
  const stanceOf = (topic: FactTopic) => facts.find((f) => f.topic === topic)?.stance;

  /*
   * Evidence the authority holds is ranked before anything the user said is
   * consulted, and it is never ranked down. Deciding this first, rather than
   * as an exception further down, is deliberate: an exception buried inside
   * the demotion rules is one refactor away from being skipped.
   */
  if (INDEPENDENT_EVIDENCE.has(evidenceType)) {
    if (evidenceType !== 'COUNCIL_PHOTOGRAPHS') {
      return { priority: 'STANDARD', reason: null };
    }

    // "Have you looked at the photographs?" answered no. Not having seen them
    // makes them more important to get, not less — the original bug read this
    // as though the user had denied that something happened.
    if (stanceOf('AUTHORITY_PHOTOGRAPHS_REVIEWED') === 'DENIED') {
      return {
        priority: 'PRIORITY',
        reason:
          'You have not looked at these yet. They are what the authority will rely on, so they are worth seeing before you decide anything.',
      };
    }

    const disputed = facts.some(
      (fact) => fact.stance === 'ASSERTED' && !NON_FACTUAL_TOPICS.has(fact.topic),
    );
    if (disputed) {
      return {
        priority: 'PRIORITY',
        reason:
          'You have told us what happened, and these are the images the authority will rely on. They may support your account or contradict it, which is why they matter either way.',
      };
    }
    return { priority: 'STANDARD', reason: null };
  }

  // Asserted by the user: this is what their account is about.
  const assertedSupport = supports.filter((topic) => stanceOf(topic) === 'ASSERTED');
  if (assertedSupport.length > 0) {
    return {
      priority: 'PRIORITY',
      reason: `You told us ${lowerFirstWord(ASSERTION_LABEL_FOR[assertedSupport[0] as FactTopic])}.`,
    };
  }

  // Explicitly denied: the user says the thing this would show did not happen.
  // Safe here only because the authority's own material never reaches this
  // branch — a user denying the allegation must not bury the evidence capable
  // of settling it.
  if (supports.length > 0 && supports.every((topic) => stanceOf(topic) === 'DENIED')) {
    return {
      priority: 'LESS_LIKELY',
      reason:
        'You told us this is not what happened, so a document showing it is unlikely to be what your case turns on.',
    };
  }

  // Superseded: the user has described a different route through the day.
  const supersededBy = (SUPERSEDED_BY[evidenceType] ?? []).find(
    (topic) => stanceOf(topic) === 'ASSERTED',
  );
  if (supersededBy) {
    return {
      priority: 'LESS_LIKELY',
      reason: `You told us ${lowerFirstWord(ASSERTION_LABEL_FOR[supersededBy])}, so this is less likely to be the point — but we have kept it here in case it still matters.`,
    };
  }

  return { priority: 'STANDARD', reason: null };
}

function lowerFirstWord(text: string): string {
  return text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
}
