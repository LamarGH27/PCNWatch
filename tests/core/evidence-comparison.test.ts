import { describe, expect, it } from 'vitest';
import {
  COMPARISON_CAUTION,
  compareEvidence,
  normaliseRegistration,
  parseDate,
  parseTime,
} from '@/core/evidence/compare';

/**
 * Comparing a document with a notice.
 *
 * Two things are being pinned here. The first is arithmetic: two strings either
 * denote the same thing or they do not, and where that cannot be decided
 * honestly the answer is NOT_COMPARED rather than a guess.
 *
 * The second is restraint. Nothing this function produces may read as a
 * verdict. A matching registration is not a defence, a differing one is not the
 * end of a case, and the statements are checked for both.
 */

const NOTICE = {
  vehicleRegistration: 'AB12 CDE',
  incidentDate: '2026-01-04',
  incidentTime: '14:30',
  contraventionCode: '12',
};

describe('comparing a document with the notice', () => {
  it('treats plate spacing as presentation', () => {
    const [comparison] = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PARKING_APP_RECEIPT',
          verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' }],
        },
      ],
      NOTICE,
    );
    expect(comparison?.outcome).toBe('CONSISTENT');
  });

  it('reports a different registration as different, without softening it', () => {
    const [comparison] = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PARKING_APP_RECEIPT',
          verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDF' }],
        },
      ],
      NOTICE,
    );
    expect(comparison?.outcome).toBe('DIFFERS');
    expect(comparison?.statement).toContain('AB12CDF');
    expect(comparison?.statement).toContain('AB12 CDE');
  });

  it('does not correct a registration towards the notice', () => {
    // O and 0 are different characters. Treating them as the same would be
    // amending the user's own document until it agreed with their notice.
    expect(normaliseRegistration('AB12 O DE')).not.toBe(normaliseRegistration('AB120DE'));
  });

  it('says a paid period covered the time only when both ends were read', () => {
    const [comparison] = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PAYMENT_RECEIPT',
          verifiedFacts: [{ field: 'TIME_FROM', value: '14:00' }],
        },
      ],
      NOTICE,
    );
    // A start time with no end is not a window: claiming it covered 14:30 would
    // mean inventing a duration nobody read off the ticket.
    expect(comparison?.outcome).toBe('NOT_COMPARED');
  });

  it('compares a full paid period against the time on the notice', () => {
    const covered = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PAYMENT_RECEIPT',
          verifiedFacts: [
            { field: 'TIME_FROM', value: '14:00' },
            { field: 'TIME_TO', value: '15:00' },
          ],
        },
      ],
      NOTICE,
    );
    expect(covered[0]?.outcome).toBe('CONSISTENT');

    const missed = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PAYMENT_RECEIPT',
          verifiedFacts: [
            { field: 'TIME_FROM', value: '09:00' },
            { field: 'TIME_TO', value: '10:00' },
          ],
        },
      ],
      NOTICE,
    );
    expect(missed[0]?.outcome).toBe('DIFFERS');
  });

  it('reports a permit that had expired before the alleged contravention', () => {
    const [comparison] = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PERMIT',
          verifiedFacts: [
            { field: 'VALID_FROM', value: '2025-01-01' },
            { field: 'VALID_TO', value: '2025-12-31' },
          ],
        },
      ],
      NOTICE,
    );
    expect(comparison?.outcome).toBe('DIFFERS');
  });

  it('will not decide a validity period it can only see one end of', () => {
    const [comparison] = compareEvidence(
      [{ id: 'e1', type: 'PERMIT', verifiedFacts: [{ field: 'VALID_TO', value: '2026-12-31' }] }],
      NOTICE,
    );
    expect(comparison?.outcome).toBe('NOT_COMPARED');
  });

  it('never compares free text', () => {
    /*
     * "Bay 12, Tavistock Place" against "TAVISTOCK PL O/S 40" is not something
     * string comparison can answer. Answering it anyway would invent agreement
     * on some cases and conflict on others.
     */
    const comparisons = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PARKING_SIGN',
          verifiedFacts: [
            { field: 'SIGN_RESTRICTION_TEXT', value: 'No loading Mon-Fri 8am-10am' },
            { field: 'LOCATION_TEXT', value: 'Tavistock Place' },
            { field: 'ZONE_OR_BAY_IDENTIFIER', value: 'CA-H' },
          ],
        },
      ],
      NOTICE,
    );
    expect(comparisons).toHaveLength(0);
  });

  it('says nothing about what a comparison means', () => {
    const comparisons = compareEvidence(
      [
        {
          id: 'e1',
          type: 'PARKING_APP_RECEIPT',
          verifiedFacts: [
            { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' },
            { field: 'DATE', value: '04/01/2026' },
            { field: 'TIME_FROM', value: '14:00' },
            { field: 'TIME_TO', value: '15:00' },
          ],
        },
      ],
      NOTICE,
    );
    expect(comparisons.length).toBeGreaterThan(0);
    const prose = comparisons.map((c) => c.statement).join(' ');
    for (const forbidden of [
      /valid defence/i,
      /you (will|should) win/i,
      /appeal will succeed/i,
      /ticket is invalid/i,
      /wrongly issued/i,
      /you have a ground/i,
      /\bunlawful\b/i,
      /\d+\s*%/,
    ]) {
      expect(prose, `a comparison read as a verdict: ${forbidden}`).not.toMatch(forbidden);
    }
    expect(COMPARISON_CAUTION).toMatch(/not a view about whether/i);
  });

  it('marks authority evidence as independent so it cannot be quietly reweighted', () => {
    const [comparison] = compareEvidence(
      [
        {
          id: 'e1',
          type: 'COUNCIL_PHOTOGRAPHS',
          verifiedFacts: [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' }],
        },
      ],
      NOTICE,
    );
    expect(comparison?.independent).toBe(true);
  });
});

describe('reading dates and times conservatively', () => {
  it('accepts ISO and UK order and nothing else', () => {
    expect(parseDate('2026-01-04')).toBe('2026-01-04');
    expect(parseDate('04/01/2026')).toBe('2026-01-04');
    expect(parseDate('4.1.2026')).toBe('2026-01-04');
    // Two-digit years are ambiguous about order as well as century.
    expect(parseDate('04/01/26')).toBeNull();
    expect(parseDate('4 January 2026')).toBeNull();
  });

  it('rejects a date that does not exist', () => {
    expect(parseDate('2026-02-30')).toBeNull();
  });

  it('reads only unambiguous 24-hour times', () => {
    expect(parseTime('14:30')).toBe(870);
    expect(parseTime('9:05')).toBe(545);
    expect(parseTime('2.30pm')).toBeNull();
    expect(parseTime('25:00')).toBeNull();
  });
});
