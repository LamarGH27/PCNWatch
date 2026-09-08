import { describe, expect, it } from 'vitest';
import {
  ALWAYS_CONFIRM_ASSERTIONS,
  MAX_FOLLOW_UPS,
  NARRATIVE_AUTO_ACCEPT_THRESHOLD,
  acceptedAssertions,
  selectFollowUps,
  triageNarrative,
} from '@/core/context/triage';
import {
  ALWAYS_VERIFY,
  FIELD_VERIFICATION_THRESHOLD,
} from '@/core/notices/verification-policy';
import {
  confirmableFromSummary,
  summariseExtraction,
  type ExtractedFieldView,
} from '@/core/notices/extraction-summary';
import type { NarrativeAssertion } from '@/core/context/types';
import { evidenceForAssertion } from '@/core/context/questions';

/**
 * The fast journey, and what it is still not allowed to skip.
 *
 * Making a product quicker is mostly a matter of deciding what not to ask. The
 * risk is that the things worth asking about go with everything else, and the
 * result is a product that feels effortless because it stopped checking. Every
 * test here is about a specific thing the fast path must still stop for.
 */

function field(
  key: string,
  overrides: Partial<ExtractedFieldView> = {},
): ExtractedFieldView {
  return {
    key,
    label: key,
    value: 'a value',
    confidence: 0.97,
    requiresVerification: ALWAYS_VERIFY.includes(key),
    hint: null,
    ...overrides,
  };
}

function assertion(
  kind: NarrativeAssertion['kind'],
  overrides: Partial<NarrativeAssertion> = {},
): NarrativeAssertion {
  return {
    kind,
    stance: 'ASSERTED',
    confidence: 0.95,
    summary: `says ${kind}`,
    source: 'USER_ACCOUNT',
    ...overrides,
  };
}

describe('the compact PCN summary', () => {
  it('offers one tap when everything was read clearly', () => {
    const summary = summariseExtraction([
      field('authorityName'),
      field('contraventionCode'),
      field('incidentDate'),
      field('fullAmountPence'),
      field('location'),
    ]);

    expect(summary.fastPathAvailable).toBe(true);
    expect(summary.mustCheck).toEqual([]);
    expect(summary.shown).toHaveLength(5);
  });

  it('confirms only fields it actually displayed', () => {
    /*
     * The invariant the whole simplification rests on. "Looks right" is a real
     * confirmation because the user saw the values; a field they were never
     * shown has not been confirmed by anything, whatever the button said.
     */
    const summary = summariseExtraction([
      field('authorityName'),
      field('issueDate', { value: null }),
      field('fullAmountPence', { confidence: 0.4 }),
    ]);

    const confirmable = confirmableFromSummary(summary);
    expect(confirmable).toEqual(['authorityName']);

    for (const key of confirmable) {
      expect(
        summary.shown.some((f) => f.key === key),
        `${key} would be confirmed without being displayed`,
      ).toBe(true);
    }
  });

  it('still stops for a field it could not read', () => {
    const summary = summariseExtraction([field('authorityName'), field('incidentDate', { value: null })]);
    expect(summary.fastPathAvailable).toBe(false);
    expect(summary.mustCheck.map((f) => f.key)).toEqual(['incidentDate']);
  });

  it('still stops for a field it read badly', () => {
    const summary = summariseExtraction([
      field('authorityName'),
      field('fullAmountPence', { confidence: FIELD_VERIFICATION_THRESHOLD - 0.01 }),
    ]);
    expect(summary.fastPathAvailable).toBe(false);
    expect(summary.mustCheck.map((f) => f.key)).toEqual(['fullAmountPence']);
  });

  it('leads with what somebody recognises their own ticket by', () => {
    const summary = summariseExtraction([
      field('pcnNumber'),
      field('issueDate'),
      field('fullAmountPence'),
      field('authorityName'),
    ]);
    // The authority and the amount, not the notice number.
    expect(summary.shown[0]?.key).toBe('authorityName');
    expect(summary.shown[1]?.key).toBe('fullAmountPence');
    // And everything is still there to be seen, because it is all confirmable.
    expect(summary.shown).toHaveLength(4);
  });
});

describe('what the reader may accept without asking', () => {
  it('accepts an ordinary confident reading', () => {
    const triage = triageNarrative([assertion('PAYMENT_BY_APP')]);
    expect(triage.mustConfirm).toEqual([]);
    expect(acceptedAssertions(triage)).toEqual([{ kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' }]);
  });

  it('stops for a claim that a document or entitlement existed', () => {
    /*
     * These become "I held a valid resident permit" in a letter to a council.
     * Getting one wrong is the single mistake an authority can disprove
     * outright, so confidence is not enough — a person looks.
     */
    for (const kind of ALWAYS_CONFIRM_ASSERTIONS) {
      const triage = triageNarrative([assertion(kind, { confidence: 1 })]);
      expect(triage.accepted, `${kind} was accepted without asking`).toEqual([]);
      expect(triage.mustConfirm[0]?.reason).toBe('MATERIAL_CLAIM');
    }
  });

  it('stops when the reader was not confident', () => {
    const triage = triageNarrative([
      assertion('PAYMENT_MADE', { confidence: NARRATIVE_AUTO_ACCEPT_THRESHOLD - 0.01 }),
    ]);
    expect(triage.mustConfirm[0]?.reason).toBe('LOW_CONFIDENCE');
  });

  it('stops when the account left something open', () => {
    const triage = triageNarrative([assertion('SIGNAGE_UNCLEAR_OR_NOT_SEEN', { stance: 'UNCLEAR' })]);
    expect(triage.mustConfirm[0]?.reason).toBe('UNCLEAR_STANCE');
  });

  it('stops when a reading contradicts an answer the user already gave', () => {
    /*
     * The contradiction case the reconciliation layer exists for. Accepting one
     * side quietly is how the product ends up holding two facts it cannot both
     * be right about — which is the bug that produced "did you pay? — no" above
     * "you paid using an app".
     */
    const triage = triageNarrative(
      [assertion('PAYMENT_MADE', { confidence: 1 })],
      [{ questionId: 'GENERAL#paid', answer: 'NO' }],
    );
    const reasons = triage.mustConfirm.map((t) => t.reason);
    expect(reasons.length + triage.accepted.length).toBe(1);
    if (triage.mustConfirm.length > 0) {
      expect(reasons[0]).toBe('CONFLICTS_WITH_ANSWER');
    }
  });

  it('produces the same shape a hand-confirmed assertion produces', () => {
    // Nothing downstream can tell how a fact came to be confirmed, and nothing
    // downstream should be able to act on it if it could.
    const accepted = acceptedAssertions(triageNarrative([assertion('PAYMENT_BY_APP')]));
    expect(Object.keys(accepted[0] ?? {}).sort()).toEqual(['kind', 'stance']);
  });
});

describe('the follow-up questions', () => {
  const paidByApp = [
    { topic: 'PAYMENT_MADE' as const, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const },
    { topic: 'PAYMENT_BY_APP' as const, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const },
    { topic: 'WRONG_VRM_POSSIBLE' as const, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const },
  ];

  it('asks the RingGo question for the RingGo account', () => {
    const followUps = selectFollowUps({ facts: paidByApp });
    expect(followUps.length).toBeGreaterThan(0);
    expect(followUps[0]?.type).toBe('PARKING_APP_RECEIPT');
    expect(followUps[0]?.prompt).toMatch(/^Do you still have/i);
  });

  it('does not ask for a paper ticket when the account says an app', () => {
    /*
     * "I paid" and "I paid using an app" are the same event at two levels of
     * detail. There is no pay-and-display receipt for an app payment, so
     * asking for one spends a question on something that cannot exist.
     */
    const followUps = selectFollowUps({ facts: paidByApp });
    expect(followUps.map((f) => f.type)).not.toContain('PAYMENT_RECEIPT');
  });

  it('still asks for the ticket when the account says only that they paid', () => {
    const followUps = selectFollowUps({
      facts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED', provenance: 'USER_ACCOUNT' }],
    });
    expect(followUps.map((f) => f.type)).toContain('PAYMENT_RECEIPT');
  });

  it('never asks more than three things', () => {
    /*
     * An account that implicates far more than three documents. The RingGo
     * fixture happens to produce fewer, so testing the cap against it passed
     * whether or not a cap existed — which is the shape of a test that is
     * really testing its own fixture.
     */
    const busy = (
      [
        'PAYMENT_BY_APP',
        'LOADING_OR_UNLOADING',
        'SIGNAGE_UNCLEAR_OR_NOT_SEEN',
        'BAY_MARKINGS_UNCLEAR',
        'WRONG_VRM_POSSIBLE',
      ] as const
    ).map((topic) => ({ topic, stance: 'ASSERTED' as const, provenance: 'USER_ACCOUNT' as const }));

    const candidatesBeforeCapping = new Set(busy.flatMap((f) => evidenceForAssertion(f.topic)));
    expect(candidatesBeforeCapping.size).toBeGreaterThan(MAX_FOLLOW_UPS);

    expect(selectFollowUps({ facts: busy })).toHaveLength(MAX_FOLLOW_UPS);
  });

  it('does not ask for what the user already told us about', () => {
    const followUps = selectFollowUps({
      facts: paidByApp,
      declared: ['PARKING_APP_RECEIPT'],
    });
    expect(followUps.map((f) => f.type)).not.toContain('PARKING_APP_RECEIPT');
  });

  it('does not ask for what we already hold', () => {
    const followUps = selectFollowUps({ facts: paidByApp, held: ['PARKING_APP_RECEIPT'] });
    expect(followUps.map((f) => f.type)).not.toContain('PARKING_APP_RECEIPT');
  });

  it('asks nothing when the account asserted nothing', () => {
    // A person who wrote only frustration is not interrogated for it.
    expect(selectFollowUps({ facts: [] })).toEqual([]);
  });

  it('does not chase evidence for a request for discretion', () => {
    /*
     * Mitigation asks an authority to exercise discretion. Following it up with
     * "do you still have..." treats a reason as a claim to be documented.
     */
    const followUps = selectFollowUps({
      facts: [
        { topic: 'MITIGATING_CIRCUMSTANCES', stance: 'ASSERTED', provenance: 'USER_ACCOUNT' },
      ],
    });
    expect(followUps).toEqual([]);
  });

  it('never lets the account rule out the authority’s own material', () => {
    /*
     * The invariant from the evidence ranking work, restated for follow-ups. A
     * user's account may decide what is relevant to ask them for; it may not
     * remove from the picture the one thing capable of contradicting them.
     */
    const followUps = selectFollowUps({
      facts: [
        { topic: 'LOADING_OR_UNLOADING', stance: 'ASSERTED', provenance: 'USER_ACCOUNT' },
        { topic: 'PAYMENT_BY_APP', stance: 'ASSERTED', provenance: 'USER_ACCOUNT' },
      ],
    });
    expect(followUps.map((f) => f.type)).toContain('COUNCIL_PHOTOGRAPHS');
  });

  it('is stable between renders', () => {
    const a = selectFollowUps({ facts: paidByApp }).map((f) => f.type);
    const b = selectFollowUps({ facts: paidByApp }).map((f) => f.type);
    expect(a).toEqual(b);
  });
});
