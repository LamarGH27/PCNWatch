import { describe, expect, it } from 'vitest';
import { toCaseRow, fromCaseRow } from '@/server/cases/persist';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { collectVerifiedFacts } from '@/app/analyse/AnalyseFlow';
import { toFieldViews, ALWAYS_VERIFY } from '@/server/cases/extraction';
import { EMPTY_USER_CONTEXT } from '@/core/context/types';

/**
 * The confirmed authority, from the verification screen to the resumed case.
 *
 * A real notice showed "Issuing authority: City of Westminster" on the
 * verification screen and the saved case came back reading "Authority not
 * identified". The persistence was never the problem — the value was dropped in
 * the browser, before anything was sent, because `collectVerifiedFacts` returns
 * only ticked fields while the submit button only ever demanded ticks on the
 * five fields in ALWAYS_VERIFY. Anything read confidently outside that list was
 * displayed, left unticked because nothing asked for a tick, and discarded.
 */

const WESTMINSTER: VerifiedFacts = {
  noticeType: 'PCN_POSTAL',
  authorityName: 'City of Westminster',
  pcnNumber: 'WM77341902',
  contraventionCode: '12',
  incidentDate: '2026-06-11',
  issueDate: '2026-06-14',
  fullAmountPence: 13000,
};

/** An extraction that read the authority clearly, as the real one did. */
function confidentExtraction() {
  const field = (value: unknown, confidence = 0.97) => ({ value, confidence, sourceHint: '' });
  return {
    authorityName: field('City of Westminster'),
    pcnNumber: field('WM77341902'),
    vehicleRegistration: field('LT19XYZ'),
    noticeType: field('PCN_POSTAL'),
    contraventionCode: field('12'),
    contraventionDescription: field('Parked in a residents’ bay'),
    incidentDate: field('2026-06-11'),
    incidentTime: field('14:32'),
    issueDate: field('2026-06-14'),
    location: field('Gloucester Place'),
    fullAmountPence: field(13000),
    discountedAmountPence: field(6500),
    discountDeadlinePrinted: field('2026-06-28'),
    representationDeadlinePrinted: field(null),
    proceduralStageIndicated: field(null),
    unreadableRegions: [],
    overallLegibility: 'CLEAR',
  } as never;
}

describe('the field the user was never asked to tick', () => {
  it('is not one the submit button demands', () => {
    // The asymmetry at the root of the bug, stated directly.
    expect(ALWAYS_VERIFY).not.toContain('authorityName');
    const views = toFieldViews(confidentExtraction());
    const authority = views.find((v) => v.key === 'authorityName');
    expect(authority).toBeDefined();
    expect(authority!.value).toBe('City of Westminster');
    expect(authority!.requiresVerification, 'the screen would have demanded a tick').toBe(false);
  });

  it('is dropped when it is left unticked', () => {
    // The old behaviour, kept as a test so the fix cannot be undone silently.
    const values = { authorityName: 'City of Westminster', pcnNumber: 'WM77341902' };
    const nothingTicked = collectVerifiedFacts(values, {}, 'PCN_POSTAL');
    expect(nothingTicked.authorityName).toBeUndefined();
  });

  it('survives once the screen marks what it is not asking about as accepted', () => {
    const views = toFieldViews(confidentExtraction());
    // What the flow now seeds `confirmed` with.
    const confirmed = Object.fromEntries(
      views.filter((v) => !v.requiresVerification).map((v) => [v.key, true]),
    );
    const values = Object.fromEntries(
      views.map((v) => [v.key, v.value === null ? '' : String(v.value)]),
    );

    const facts = collectVerifiedFacts(values, confirmed, 'PCN_POSTAL');
    expect(facts.authorityName).toBe('City of Westminster');
    // And the other quietly-dropped fields come back too.
    expect(facts.location).toBe('Gloucester Place');
    expect(facts.vehicleRegistration).toBe('LT19XYZ');
    expect(facts.discountDeadlinePrinted).toBe('2026-06-28');
  });

  it('still withholds the fields the user really must check', () => {
    const views = toFieldViews(confidentExtraction());
    const confirmed = Object.fromEntries(
      views.filter((v) => !v.requiresVerification).map((v) => [v.key, true]),
    );
    const values = Object.fromEntries(
      views.map((v) => [v.key, v.value === null ? '' : String(v.value)]),
    );

    const facts = collectVerifiedFacts(values, confirmed, 'PCN_POSTAL');
    for (const key of ALWAYS_VERIFY) {
      expect(
        (facts as unknown as Record<string, unknown>)[key],
        `${key} was accepted without the user checking it`,
      ).toBeUndefined();
    }
  });
});

describe('the confirmed authority survives the round trip', () => {
  it('is written to the row exactly as confirmed', () => {
    const row = toCaseRow(WESTMINSTER, EMPTY_USER_CONTEXT);
    expect(row.authority_name_raw).toBe('City of Westminster');
    // Never derived from anything else. There is no authority id, no lookup by
    // PCN number, no inference from a location or a borough.
    expect(row.authority_id).toBeUndefined();
  });

  it('comes back from the row unchanged', () => {
    const stored = fromCaseRow({
      ...toCaseRow(WESTMINSTER, EMPTY_USER_CONTEXT),
      id: 'case-1',
      updated_at: '2026-09-07T00:00:00Z',
    });
    expect(stored.facts.authorityName).toBe('City of Westminster');
  });

  it('reaches the resumed assessment', () => {
    const stored = fromCaseRow({
      ...toCaseRow(WESTMINSTER, EMPTY_USER_CONTEXT),
      id: 'case-1',
      updated_at: '2026-09-07T00:00:00Z',
    });
    const result = assessVerifiedNotice(stored.facts, stored.context, '2026-09-07');
    expect(result.authority.name).toBe('City of Westminster');
  });

  it('stays absent when the user did not confirm it', () => {
    // The other half of the rule: no authority is better than one we guessed.
    const row = toCaseRow({ ...WESTMINSTER, authorityName: undefined }, EMPTY_USER_CONTEXT);
    expect(row.authority_name_raw).toBeNull();

    const stored = fromCaseRow({ ...row, id: 'case-1', updated_at: '' });
    expect(stored.facts.authorityName).toBeUndefined();

    const result = assessVerifiedNotice(stored.facts, stored.context, '2026-09-07');
    expect(result.authority.name).toBeNull();
    // And nothing filled it in from the PCN number, the code or the location.
    expect(JSON.stringify(result)).not.toMatch(/westminster/i);
  });
});
