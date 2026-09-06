import { describe, expect, it } from 'vitest';
import {
  evidenceRelevance,
  mappingFor,
  questionMappings,
  reconcileContext,
} from '@/core/context/reconcile';
import { evidenceForAssertion } from '@/core/context/questions';
import { resolveQuestionPrompt } from '@/core/context/questions';
import type { ContextAnswer } from '@/core/context/types';

/**
 * Reconciling the two ways a user tells us the same thing.
 *
 * A real assessment displayed both of these at once:
 *
 *     "Did you buy a pay-and-display ticket or pay by app instead? — no."
 *     "you paid to park; you paid using an app"
 *
 * Each was a faithful record. Showing them together as though they agreed was
 * the defect, and these cover the machinery that stops it.
 */

const PAYMENT_QUESTION = 'CONTRAVENTION-12#3';
const PERMIT_QUESTION = 'CONTRAVENTION-12#0';

function answers(...entries: ContextAnswer[]): ContextAnswer[] {
  return entries;
}

describe('the question mappings are anchored to real wording', () => {
  it('every mapping still matches the question it was written against', () => {
    // Question ids are positional. If a reference record is reordered or
    // reworded, a mapping silently re-points at a different question — so each
    // one records the wording it was written for, and this is what catches the
    // drift before it ships.
    for (const mapping of questionMappings()) {
      expect(
        resolveQuestionPrompt(mapping.questionId),
        `${mapping.questionId} no longer reads as the mapping expects`,
      ).toBe(mapping.expectedPrompt);
    }
  });

  it('ignores a mapping whose question has moved', () => {
    // The runtime behaviour when drift does happen: no mapping, so no
    // reconciliation and no conflict — never a conflict about the wrong question.
    expect(mappingFor('CONTRAVENTION-12#999')).toBeNull();
    expect(mappingFor('nonsense')).toBeNull();
  });
});

describe('an unanswered question is never a no', () => {
  it('produces no fact at all', () => {
    const result = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'UNANSWERED' }),
      [],
    );
    expect(result.facts).toEqual([]);
    expect(result.conflicts).toEqual([]);
  });

  it('does not contradict an account that says the opposite', () => {
    // The failure this guards: an untouched question read as a denial, which
    // would manufacture a conflict out of nothing and stop the user's real
    // account from counting.
    const result = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'UNANSWERED' }),
      [{ kind: 'PAYMENT_MADE', stance: 'ASSERTED' }],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.facts).toEqual([
      { topic: 'PAYMENT_MADE', stance: 'ASSERTED', provenance: 'USER_ACCOUNT' },
    ]);
  });

  it('is different from not being sure', () => {
    const notSure = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'NOT_SURE' }),
      [],
    );
    expect(notSure.facts).toEqual([
      { topic: 'PAYMENT_MADE', stance: 'UNCLEAR', provenance: 'QUESTION_RESPONSE' },
    ]);

    const untouched = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'UNANSWERED' }),
      [],
    );
    expect(untouched.facts).toEqual([]);
  });
});

describe('the reported contradiction', () => {
  it('raises a conflict for the RingGo scenario', () => {
    // Exactly what was on screen: the questionnaire said no, the confirmed
    // account said the session was paid for.
    const result = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'NO' }),
      [
        { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
        { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
        { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
      ],
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]!.topic).toBe('PAYMENT_MADE');
    expect(result.conflicts[0]!.fromQuestion).toBe('DENIED');
    expect(result.conflicts[0]!.fromAccount).toBe('ASSERTED');
    expect(result.conflicts[0]!.questionPrompt).toBe(
      'Did you buy a pay-and-display ticket or pay by app instead?',
    );

    // And the disputed fact appears in neither version. Choosing one silently
    // is the thing this exists to prevent.
    expect(result.facts.map((f) => f.topic)).not.toContain('PAYMENT_MADE');
    // The topics that are not in dispute are unaffected.
    expect(result.facts.map((f) => f.topic)).toContain('PAYMENT_BY_APP');
    expect(result.facts.map((f) => f.topic)).toContain('WRONG_VRM_POSSIBLE');
  });

  it('produces one canonical fact once the user chooses', () => {
    const result = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'NO' }),
      [{ kind: 'PAYMENT_MADE', stance: 'ASSERTED' }],
      [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
    );

    expect(result.conflicts).toEqual([]);
    expect(result.facts).toEqual([
      { topic: 'PAYMENT_MADE', stance: 'ASSERTED', provenance: 'BOTH' },
    ]);
  });

  it('honours a resolution that goes against the account', () => {
    // The user is allowed to decide the questionnaire was the right one.
    const result = reconcileContext(
      answers({ questionId: PAYMENT_QUESTION, answer: 'NO' }),
      [{ kind: 'PAYMENT_MADE', stance: 'ASSERTED' }],
      [{ topic: 'PAYMENT_MADE', stance: 'DENIED' }],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.facts[0]!.stance).toBe('DENIED');
  });
});

describe('agreement merges instead of duplicating', () => {
  it('produces one fact, marked as coming from both', () => {
    const result = reconcileContext(
      answers({ questionId: PERMIT_QUESTION, answer: 'YES' }),
      [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }],
    );

    expect(result.facts).toEqual([
      { topic: 'HELD_PERMIT', stance: 'ASSERTED', provenance: 'BOTH' },
    ]);
    expect(result.conflicts).toEqual([]);
  });

  it('does not treat a soft answer as disagreement', () => {
    // "Not sure" plus "yes" is not a contradiction to put to somebody. Asking
    // them to reconcile a definite answer with an uncertain one is asking a
    // question that has no answer.
    const result = reconcileContext(
      answers({ questionId: PERMIT_QUESTION, answer: 'NOT_SURE' }),
      [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }],
    );
    expect(result.conflicts).toEqual([]);
    expect(result.facts[0]!.stance).toBe('ASSERTED');
  });

  it('handles an inverted question correctly', () => {
    // "Was the correct registration linked to it?" answered yes means the
    // wrong registration was NOT entered.
    const result = reconcileContext(
      answers({ questionId: 'CONTRAVENTION-12#1', answer: 'YES' }),
      [],
    );
    expect(result.facts).toEqual([
      { topic: 'WRONG_VRM_POSSIBLE', stance: 'DENIED', provenance: 'QUESTION_RESPONSE' },
    ]);
  });

  it('keeps a question it cannot map, rather than dropping the answer', () => {
    const result = reconcileContext(
      answers({ questionId: 'CONTRAVENTION-12#2', answer: 'NO' }),
      [],
    );
    expect(result.facts).toEqual([]);
    expect(result.unmappedAnswers).toHaveLength(1);
    expect(result.unmappedAnswers[0]!.questionId).toBe('CONTRAVENTION-12#2');
  });
});

describe('evidence follows what the user confirmed', () => {
  const paidByApp = [
    { topic: 'PAYMENT_MADE' as const, stance: 'ASSERTED' as const, provenance: 'BOTH' as const },
    { topic: 'PAYMENT_BY_APP' as const, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const },
    { topic: 'WRONG_VRM_POSSIBLE' as const, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const },
  ];

  const supports = (type: string) =>
    paidByApp.map((f) => f.topic).filter((topic) => evidenceForAssertion(topic).includes(type as never));

  it('puts the app session and the receipt first', () => {
    expect(evidenceRelevance('PARKING_APP_RECEIPT', supports('PARKING_APP_RECEIPT'), paidByApp).priority).toBe(
      'PRIORITY',
    );
    expect(evidenceRelevance('PAYMENT_RECEIPT', supports('PAYMENT_RECEIPT'), paidByApp).priority).toBe(
      'PRIORITY',
    );
  });

  it('de-prioritises the permit, and says why', () => {
    const permit = evidenceRelevance('PERMIT', supports('PERMIT'), paidByApp);
    expect(permit.priority).toBe('LESS_LIKELY');
    expect(permit.reason).toMatch(/you paid to park/i);
    // Kept, not removed: they may still have had one.
    expect(permit.reason).toMatch(/in case it still matters/i);
  });

  it('leaves evidence alone when nothing confirmed bears on it', () => {
    expect(evidenceRelevance('PARKING_SIGN', [], paidByApp)).toEqual({
      priority: 'STANDARD',
      reason: null,
    });
  });

  it('does not de-prioritise on an unconfirmed guess', () => {
    // Nothing confirmed at all: every item stays exactly where the
    // contravention put it. Relevance is earned by a confirmed fact, never
    // assumed from silence.
    for (const type of ['PERMIT', 'PAYMENT_RECEIPT', 'PARKING_APP_RECEIPT', 'PARKING_SIGN']) {
      expect(evidenceRelevance(type, [], []).priority, `${type} moved on no evidence`).toBe(
        'STANDARD',
      );
    }
  });
});
