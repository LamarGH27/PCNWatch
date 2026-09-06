import { describe, expect, it } from 'vitest';
import { toCaseRow, fromCaseRow } from '@/server/cases/persist';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';

/**
 * What a saved case is made of, and what it deliberately is not.
 *
 * The round trip has one job: a case reopened tomorrow must produce the same
 * assessment as the one its owner saw today. It also has one prohibition, which
 * is that the user's own account never becomes part of it — there is no column
 * for it since migration 0014, and nothing here should try to invent one.
 */

const WESTMINSTER: VerifiedFacts = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'Westminster City Council',
  pcnNumber: 'WM77341902',
  vehicleRegistration: 'LT19XYZ',
  contraventionCode: '12',
  contraventionDescription: 'Parked in a residents’ bay without a valid permit',
  incidentDate: '2026-08-11',
  incidentTime: '14:32',
  issueDate: '2026-08-14',
  location: 'Gloucester Place',
  fullAmountPence: 13000,
  discountedAmountPence: 6500,
  discountDeadlinePrinted: '2026-08-28',
};

const RINGGO: UserContext = {
  ...EMPTY_USER_CONTEXT,
  narrativeProvided: true,
  answers: [{ questionId: 'GENERAL#council-photographs', answer: 'NO' }],
  declaredEvidence: [{ type: 'PARKING_APP_RECEIPT', held: 'HAVE' }],
  confirmedAssertions: [
    { kind: 'PAYMENT_MADE', stance: 'ASSERTED' },
    { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED' },
    { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED' },
  ],
  resolvedFacts: [{ topic: 'PAYMENT_MADE', stance: 'ASSERTED' }],
};

/** Simulates the row coming back from Postgres, with its own type quirks. */
function roundTrip(facts: VerifiedFacts, context: UserContext) {
  const row = toCaseRow(facts, context);
  return fromCaseRow({
    ...row,
    id: '55555555-5555-5555-5555-555555555555',
    updated_at: '2026-09-06T10:00:00Z',
    // Postgres returns a time column as HH:MM:SS.
    incident_time: row.incident_time ? `${String(row.incident_time)}:00` : null,
  });
}

describe('a saved case rebuilds the same assessment', () => {
  it('returns every verified fact unchanged', () => {
    const stored = roundTrip(WESTMINSTER, RINGGO);
    expect(stored.facts).toEqual(WESTMINSTER);
  });

  it('returns the canonical context unchanged', () => {
    const stored = roundTrip(WESTMINSTER, RINGGO);
    expect(stored.context).toEqual(RINGGO);
  });

  it('produces an identical assessment to the one the user saw', () => {
    // The reason regeneration is preferred over a stored snapshot: this is the
    // only property that matters, and it holds without a second source of truth
    // that could drift from the first.
    const live = assessVerifiedNotice(WESTMINSTER, RINGGO);
    const stored = roundTrip(WESTMINSTER, RINGGO);
    const resumed = assessVerifiedNotice(stored.facts, stored.context);

    expect(resumed).toEqual(live);
  });

  it('keeps the printed deadline, which is often the only date shown', () => {
    // Calculated dates are withheld while their timing rule is unreviewed, so
    // losing the printed one on resume would leave the page with no date at all.
    const stored = roundTrip(WESTMINSTER, RINGGO);
    expect(stored.facts.discountDeadlinePrinted).toBe('2026-08-28');
    expect(assessVerifiedNotice(stored.facts, stored.context).printedDeadlines).toHaveLength(1);
  });

  it('survives a case with almost nothing confirmed', () => {
    const sparse: VerifiedFacts = { noticeType: 'UNKNOWN' };
    const stored = roundTrip(sparse, EMPTY_USER_CONTEXT);
    expect(stored.facts).toEqual(sparse);
    expect(stored.context).toEqual(EMPTY_USER_CONTEXT);
  });
});

describe('what is written down', () => {
  it('records that an account exists, and nothing of what it said', () => {
    const row = toCaseRow(WESTMINSTER, RINGGO);
    expect(row.narrative_provided).toBe(true);
    // There is no column for it — 0014 dropped `user_narrative` — and nothing
    // here reintroduces one under another name.
    for (const key of Object.keys(row)) {
      expect(key, `${key} looks like a place for the account`).not.toMatch(/narrative$/);
    }
  });

  it('writes no owner, because the database decides it', () => {
    // `user_id` defaults to auth.uid() and RLS checks the same value. A user id
    // in this row would be a value that could be wrong; there is not one.
    expect(Object.keys(toCaseRow(WESTMINSTER, RINGGO))).not.toContain('user_id');
  });

  it('stores confirmed assertions as kind and stance only', () => {
    const row = toCaseRow(WESTMINSTER, RINGGO);
    const assertions = row.confirmed_assertions as Record<string, unknown>[];

    expect(assertions).toHaveLength(3);
    for (const assertion of assertions) {
      expect(Object.keys(assertion).sort()).toEqual(['kind', 'stance']);
      // No summary: the model's sentence is drawn from the account and would
      // restate it, so storing it would store the account by another name.
      expect(assertion).not.toHaveProperty('summary');
      expect(assertion).not.toHaveProperty('confidence');
    }
  });

  it('cannot carry an unconfirmed reading, because there is nowhere to put one', () => {
    // An extraction the user never accepted is not a ConfirmedAssertion, so it
    // cannot be in the context, so it cannot reach the row. Proven by writing a
    // context that has extractions but no confirmations.
    const row = toCaseRow(WESTMINSTER, { ...EMPTY_USER_CONTEXT, narrativeProvided: true });
    expect(row.confirmed_assertions).toEqual([]);
  });

  it('derives the classification rather than trusting what it was sent', () => {
    const council = toCaseRow(WESTMINSTER, EMPTY_USER_CONTEXT);
    expect(council.notice_category).toBe('LOCAL_AUTHORITY_PCN');
    expect(council.procedural_stage).toBe('NEW');

    const private_ = toCaseRow(
      { ...WESTMINSTER, noticeType: 'PRIVATE_PARKING_CHARGE', authorityName: 'ParkingEye Ltd' },
      EMPTY_USER_CONTEXT,
    );
    expect(private_.notice_category).toBe('PRIVATE_PARKING_CHARGE');
  });

  it('normalises the contravention code it stores', () => {
    const row = toCaseRow({ ...WESTMINSTER, contraventionCode: '1' }, EMPTY_USER_CONTEXT);
    expect(row.contravention_code).toBe('01');
  });

  it('records the case as verified, so a failed assessment still leaves it saved', () => {
    expect(toCaseRow(WESTMINSTER, RINGGO).status).toBe('VERIFIED');
  });

  it('records which fields the user actually ticked', () => {
    const confirmed = toCaseRow(WESTMINSTER, EMPTY_USER_CONTEXT).verified_fields as Record<string, boolean>;
    expect(confirmed.pcnNumber).toBe(true);
    expect(confirmed.location).toBe(true);

    // A field the user did not confirm never arrived, and is recorded as such.
    const partial = toCaseRow({ noticeType: 'PCN_POSTAL' }, EMPTY_USER_CONTEXT)
      .verified_fields as Record<string, boolean>;
    expect(partial.pcnNumber).toBe(false);
    expect(partial.location).toBe(false);
  });
});

describe('a row that has been tampered with', () => {
  it('treats a non-array context as empty rather than crashing on resume', () => {
    // The database has a check constraint for this, but a reader that trusts
    // its input turns a bad row into a 500 on someone's case page.
    const stored = fromCaseRow({
      id: '55555555-5555-5555-5555-555555555555',
      notice_type: 'PCN_POSTAL',
      confirmed_assertions: { not: 'an array' },
      context_answers: null,
      declared_evidence: 'nonsense',
      resolved_facts: 42,
    });

    expect(stored.context.confirmedAssertions).toEqual([]);
    expect(stored.context.answers).toEqual([]);
    expect(stored.context.declaredEvidence).toEqual([]);
    expect(stored.context.resolvedFacts).toEqual([]);
  });

  it('produces an assessment from a half-empty row rather than failing', () => {
    const stored = fromCaseRow({ id: 'x', notice_type: 'PCN_POSTAL' });
    const result = assessVerifiedNotice(stored.facts, stored.context);
    expect(result.assessment.basis).toBe('INSUFFICIENT_INFORMATION');
  });
});
