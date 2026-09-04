import { describe, expect, it } from 'vitest';
import { addWorkingDays, calculateAllDeadlines, calculateDeadline } from '@/core/deadlines/calculate';
import { addDays, daysBetween, isIsoDate } from '@/core/deadlines/date-utils';
import type { DeadlineResult } from '@/core/deadlines/types';

function ok(result: DeadlineResult) {
  if (!('calculated' in result) || result.calculated !== true) {
    throw new Error(`Expected a calculated deadline, got ${JSON.stringify(result)}`);
  }
  return result;
}

describe('calendar helpers', () => {
  it('rejects impossible calendar dates', () => {
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-2-1')).toBe(false);
    expect(isIsoDate('2026-02-28')).toBe(true);
  });

  it('handles leap years', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2025-02-29')).toBe(false);
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29');
    expect(addDays('2024-02-29', 1)).toBe('2024-03-01');
    expect(addDays('2025-02-28', 1)).toBe('2025-03-01');
  });

  it('crosses month and year boundaries', () => {
    expect(addDays('2025-12-20', 14)).toBe('2026-01-03');
    expect(addDays('2026-01-31', 28)).toBe('2026-02-28');
    expect(daysBetween('2025-12-31', '2026-01-01')).toBe(1);
  });

  it('is unaffected by British Summer Time transitions', () => {
    // BST began 2026-03-29 and ends 2026-10-25 in the UK. Calendar arithmetic must
    // not drift by an hour/day across either boundary.
    expect(addDays('2026-03-28', 14)).toBe('2026-04-11');
    expect(addDays('2026-10-24', 14)).toBe('2026-11-07');
    expect(daysBetween('2026-03-28', '2026-04-11')).toBe(14);
    expect(daysBetween('2026-10-24', '2026-11-07')).toBe(14);
  });

  it('skips weekends when adding working days', () => {
    // 2026-01-02 is a Friday.
    expect(addWorkingDays('2026-01-02', 1)).toBe('2026-01-05');
    expect(addWorkingDays('2026-01-02', 2)).toBe('2026-01-06');
    // 2026-01-03 is a Saturday.
    expect(addWorkingDays('2026-01-03', 2)).toBe('2026-01-06');
  });
});

describe('deadline calculation', () => {
  it('calculates the discount deadline from a verified service date', () => {
    const result = ok(
      calculateDeadline('DISCOUNT_EXPIRY', {
        pcnServedDate: '2026-01-05',
        verifiedDates: { pcnServedDate: true },
      }),
    );
    expect(result.calculatedDueDate).toBe('2026-01-19');
    expect(result.triggerDate).toBe('2026-01-05');
    expect(result.userVerified).toBe(true);
    expect(result.calculationRule).toBe('LDN-DISCOUNT-14D@1');
    expect(result.referenceKey).toBeTruthy();
  });

  it('refuses rather than guessing when the trigger date is missing', () => {
    const result = calculateDeadline('TRIBUNAL_APPEAL_DEADLINE', { pcnServedDate: '2026-01-05' });
    expect(result).toMatchObject({ calculated: false, reason: 'MISSING_TRIGGER_DATE' });
  });

  it('refuses when the supplied trigger date is not a real date', () => {
    const result = calculateDeadline('DISCOUNT_EXPIRY', { pcnServedDate: '2026-02-30' });
    expect(result).toMatchObject({ calculated: false, reason: 'INVALID_TRIGGER_DATE' });
  });

  it('warns when a date has not been confirmed by the user', () => {
    const result = ok(calculateDeadline('DISCOUNT_EXPIRY', { pcnServedDate: '2026-01-05' }));
    expect(result.userVerified).toBe(false);
    expect(result.warnings.some((w) => w.includes('not been confirmed'))).toBe(true);
    expect(result.confidence).not.toBe('HIGH');
  });

  it('derives a posted service date via deemed service and flags it as estimated', () => {
    // 2026-01-02 is a Friday; +2 working days = Tuesday 2026-01-06.
    const result = ok(
      calculateDeadline('DISCOUNT_EXPIRY', {
        postedDate: '2026-01-02',
        serviceMethod: 'POSTED',
      }),
    );
    expect(result.triggerDate).toBe('2026-01-06');
    expect(result.calculatedDueDate).toBe('2026-01-20');
    expect(result.confidence).not.toBe('HIGH');
    expect(result.warnings.some((w) => w.includes('Public holidays'))).toBe(true);
  });

  it('does not derive a service date for notices affixed to the vehicle', () => {
    const result = calculateDeadline('DISCOUNT_EXPIRY', {
      postedDate: '2026-01-02',
      serviceMethod: 'AFFIXED_TO_VEHICLE',
    });
    expect(result).toMatchObject({ calculated: false, reason: 'MISSING_TRIGGER_DATE' });
  });

  it('never reports HIGH confidence while the underlying rule is unreviewed', () => {
    const result = ok(
      calculateDeadline('FORMAL_REPRESENTATION_DEADLINE', {
        noticeToOwnerServedDate: '2026-01-05',
        verifiedDates: { noticeToOwnerServedDate: true },
        requireReviewedRules: true,
      }),
    );
    expect(result.confidence).toBe('MEDIUM');
    expect(result.warnings.some((w) => w.includes('awaiting review'))).toBe(true);
  });

  it('produces a result for every rule type, refusing the ones it cannot support', () => {
    const results = calculateAllDeadlines({
      pcnServedDate: '2026-01-05',
      verifiedDates: { pcnServedDate: true },
    });
    const calculated = results.filter((r) => 'calculated' in r && r.calculated);
    const refused = results.filter((r) => 'calculated' in r && r.calculated === false);
    expect(calculated.length).toBeGreaterThan(0);
    expect(refused.length).toBeGreaterThan(0);
    // Nothing derived from a Notice to Owner we do not have.
    expect(
      results.find((r) => r.deadlineType === 'FORMAL_REPRESENTATION_DEADLINE'),
    ).toMatchObject({ calculated: false });
  });

  it('is deterministic', () => {
    const input = { noticeOfRejectionServedDate: '2026-03-01', verifiedDates: { noticeOfRejectionServedDate: true } };
    const a = calculateDeadline('TRIBUNAL_APPEAL_DEADLINE', input);
    const b = calculateDeadline('TRIBUNAL_APPEAL_DEADLINE', input);
    expect(a).toEqual(b);
    expect(ok(a).calculatedDueDate).toBe('2026-03-29');
  });
});
