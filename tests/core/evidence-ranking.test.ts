import { describe, expect, it } from 'vitest';
import {
  evidenceRelevance,
  isIndependentEvidence,
  reconcileContext,
} from '@/core/context/reconcile';
import { evidenceForAssertion } from '@/core/context/questions';
import { NARRATIVE_ASSERTION_KINDS, type NarrativeAssertionKind } from '@/core/context/types';
import { EVIDENCE_TYPES, type EvidenceType } from '@/core/evidence/types';

/**
 * What the user's account may and may not do to the evidence list.
 *
 * Two real defects sit behind these. An assessment told a user "you held a
 * permit" when all they had written was that they paid through RingGo; and it
 * buried "The authority's photographs" under "less likely to matter here"
 * because the user disputed the allegation — which is precisely when those
 * photographs matter most.
 */

const RINGGO = [
  { kind: 'PAYMENT_MADE' as const, stance: 'ASSERTED' as const },
  { kind: 'PAYMENT_BY_APP' as const, stance: 'ASSERTED' as const },
  { kind: 'WRONG_VRM_POSSIBLE' as const, stance: 'ASSERTED' as const },
];

function supportsFor(type: EvidenceType, facts: readonly { topic: NarrativeAssertionKind }[]) {
  return facts
    .map((f) => f.topic)
    .filter((topic) => (evidenceForAssertion(topic) as readonly string[]).includes(type));
}

describe('paying is not holding a permit', () => {
  it('produces no permit fact from the RingGo account', () => {
    // "I paid using RingGo but may have selected the wrong registration."
    const { facts } = reconcileContext([], RINGGO);
    const topics = facts.map((f) => f.topic);

    expect(topics).toContain('PAYMENT_MADE');
    expect(topics).toContain('PAYMENT_BY_APP');
    expect(topics).toContain('WRONG_VRM_POSSIBLE');
    expect(topics, 'a permit was inferred from a payment').not.toContain('HELD_PERMIT');
    expect(topics, 'a valid permit was inferred from a payment').not.toContain('PERMIT_VALID');
  });

  it('derives no fact of any kind that was not asserted', () => {
    // The general form of the same rule. A canonical fact exists only where a
    // question was answered about it or an assertion was confirmed for it —
    // there is no inference step anywhere, for any topic.
    for (const kind of NARRATIVE_ASSERTION_KINDS) {
      const { facts } = reconcileContext([], [{ kind, stance: 'ASSERTED' }]);
      expect(
        facts.map((f) => f.topic),
        `asserting ${kind} produced facts it was not asked to`,
      ).toEqual([kind]);
    }
  });

  it('does not prioritise permit evidence on a payment account', () => {
    const { facts } = reconcileContext([], RINGGO);
    const permit = evidenceRelevance('PERMIT', supportsFor('PERMIT', facts), facts);

    expect(permit.priority).not.toBe('PRIORITY');
    expect(permit.reason ?? '', 'the permit was justified by a permit claim').not.toMatch(
      /you held a permit/i,
    );
  });

  it('does prioritise permit evidence when a permit really was confirmed', () => {
    // The rule is about inference, not about suppressing a genuine claim.
    const { facts } = reconcileContext([], [{ kind: 'HELD_PERMIT', stance: 'ASSERTED' }]);
    const permit = evidenceRelevance('PERMIT', supportsFor('PERMIT', facts), facts);

    expect(permit.priority).toBe('PRIORITY');
    expect(permit.reason).toMatch(/you held a permit/i);
  });
});

describe('the authority’s own evidence is never buried by a denial', () => {
  it('keeps photographs prominent when the user disputes the allegation', () => {
    const { facts } = reconcileContext([], RINGGO);
    const photos = evidenceRelevance('COUNCIL_PHOTOGRAPHS', supportsFor('COUNCIL_PHOTOGRAPHS', facts), facts);

    expect(photos.priority).toBe('PRIORITY');
    expect(photos.reason).toMatch(/support your account or contradict it/i);
    // The exact sentence that was wrong.
    expect(photos.reason ?? '').not.toMatch(/unlikely to be what your case turns on/i);
  });

  it('promotes photographs the user has not looked at, rather than demoting them', () => {
    // "Have you looked at the photographs the authority took?" — no. That was
    // being read as a denial that something happened. Not having seen them
    // makes them more important, not less.
    const { facts } = reconcileContext(
      [{ questionId: 'GENERAL#council-photographs', answer: 'NO' }],
      [{ kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' }],
    );
    const photos = evidenceRelevance('COUNCIL_PHOTOGRAPHS', supportsFor('COUNCIL_PHOTOGRAPHS', facts), facts);

    expect(photos.priority).toBe('PRIORITY');
    expect(photos.reason).toMatch(/you have not looked at these yet/i);
  });

  it('never drops independent evidence below standard, whatever the user says', () => {
    /*
     * The invariant, checked exhaustively rather than by example: for every
     * assertion kind, in every stance, no piece of authority-held evidence may
     * end up in the "less likely" band. A user's account may decide what is
     * most relevant; it may not decide what is allowed to contradict them.
     */
    for (const kind of NARRATIVE_ASSERTION_KINDS) {
      for (const stance of ['ASSERTED', 'DENIED', 'UNCLEAR'] as const) {
        const { facts } = reconcileContext([], [{ kind, stance }]);
        for (const type of EVIDENCE_TYPES.filter(isIndependentEvidence)) {
          const relevance = evidenceRelevance(type, supportsFor(type, facts), facts);
          expect(
            relevance.priority,
            `${type} was demoted because the user said ${kind} was ${stance}`,
          ).not.toBe('LESS_LIKELY');
        }
      }
    }
  });

  it('counts the notice image and the authority photographs as independent', () => {
    expect(isIndependentEvidence('COUNCIL_PHOTOGRAPHS')).toBe(true);
    expect(isIndependentEvidence('PCN_IMAGE')).toBe(true);
    // The user's own documents are not: a denial may reasonably demote those.
    expect(isIndependentEvidence('PERMIT')).toBe(false);
    expect(isIndependentEvidence('PARKING_APP_RECEIPT')).toBe(false);
  });

  it('still allows a denial to demote the user’s own document', () => {
    // The rule is about evidence that can contradict the account, not about
    // never demoting anything.
    const { facts } = reconcileContext([], [{ kind: 'HELD_PERMIT', stance: 'DENIED' }]);
    const permit = evidenceRelevance('PERMIT', supportsFor('PERMIT', facts), facts);
    expect(permit.priority).toBe('LESS_LIKELY');
  });

  it('does not promote photographs when the user has said nothing', () => {
    // Prominence is earned by a dispute existing, not assumed.
    const photos = evidenceRelevance('COUNCIL_PHOTOGRAPHS', [], []);
    expect(photos.priority).toBe('STANDARD');
    expect(photos.reason).toBeNull();
  });

  it('does not treat mitigation alone as a factual dispute', () => {
    // Asking for discretion is not disputing what happened, so it does not by
    // itself make the photographs the headline.
    for (const kind of ['MITIGATING_CIRCUMSTANCES', 'VEHICLE_BROKE_DOWN'] as const) {
      const { facts } = reconcileContext([], [{ kind, stance: 'ASSERTED' }]);
      const photos = evidenceRelevance('COUNCIL_PHOTOGRAPHS', supportsFor('COUNCIL_PHOTOGRAPHS', facts), facts);
      expect(photos.priority, `${kind} promoted the photographs`).toBe('STANDARD');
    }
  });
});
