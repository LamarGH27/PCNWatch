import { describe, expect, it } from 'vitest';
import {
  computeTicketActivityScores,
  classify,
} from '@/core/scoring/ticket-activity-score';
import { DEFAULT_SCORING_CONFIG, MODEL_VERSION } from '@/core/scoring/config';
import type { LocationActivityInput, ScoreResult } from '@/core/scoring/types';

const AS_OF = '2026-01-15';

function uniformTemporal(total: number) {
  return {
    hourCounts: Array.from({ length: 24 }, () => total / 24),
    dayOfWeekCounts: Array.from({ length: 7 }, () => total / 7),
  };
}

function makeLocation(
  id: string,
  monthlyCounts: number[],
  overrides: Partial<LocationActivityInput> = {},
): LocationActivityInput {
  // monthlyCounts[0] is the oldest month; last entry is the current month.
  const buckets = monthlyCounts.map((count, index) => {
    const monthsAgo = monthlyCounts.length - 1 - index;
    const d = new Date(Date.UTC(2026, 0, 1));
    d.setUTCMonth(d.getUTCMonth() - monthsAgo);
    return { periodStart: d.toISOString().slice(0, 10), count };
  });
  const total = monthlyCounts.reduce((a, b) => a + b, 0);
  return {
    locationId: id,
    buckets,
    temporal: uniformTemporal(total),
    dataConfidence: 0.9,
    hasGeometry: true,
    ...overrides,
  };
}

/** A population large enough to satisfy minComparisonPopulation. */
function population(): LocationActivityInput[] {
  return [
    makeLocation('quiet', [1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 1]),
    makeLocation('low', [2, 2, 1, 2, 3, 2, 2, 1, 2, 2, 3, 2]),
    makeLocation('mid', [8, 7, 9, 8, 10, 9, 8, 9, 7, 8, 9, 8]),
    makeLocation('busy', [30, 32, 28, 31, 35, 33, 30, 29, 34, 31, 30, 32]),
    makeLocation('busiest', [90, 95, 88, 92, 99, 94, 91, 89, 96, 93, 90, 97]),
    makeLocation('mid2', [7, 6, 8, 7, 9, 8, 7, 8, 6, 7, 8, 7]),
  ];
}

function scored(results: ScoreResult[], id: string) {
  const r = results.find((x) => x.locationId === id);
  if (!r || !('scored' in r) || r.scored !== true) {
    throw new Error(`Expected ${id} to be scored, got ${JSON.stringify(r)}`);
  }
  return r;
}

describe('Ticket Activity Score', () => {
  it('is deterministic across repeated runs with identical inputs', () => {
    const a = computeTicketActivityScores(population(), { asOf: AS_OF });
    const b = computeTicketActivityScores(population(), { asOf: AS_OF });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it('is invariant to the order locations are supplied in', () => {
    const forward = computeTicketActivityScores(population(), { asOf: AS_OF });
    const reversed = computeTicketActivityScores([...population()].reverse(), { asOf: AS_OF });
    for (const id of ['quiet', 'low', 'mid', 'busy', 'busiest']) {
      const f = forward.find((r) => r.locationId === id);
      const rv = reversed.find((r) => r.locationId === id);
      expect(rv).toEqual(f);
    }
  });

  it('ranks busier locations above quieter ones', () => {
    const results = computeTicketActivityScores(population(), { asOf: AS_OF });
    expect(scored(results, 'busiest').score).toBeGreaterThan(scored(results, 'busy').score);
    expect(scored(results, 'busy').score).toBeGreaterThan(scored(results, 'mid').score);
    expect(scored(results, 'mid').score).toBeGreaterThan(scored(results, 'low').score);
  });

  it('always produces a score inside 0-100 and a matching classification', () => {
    const results = computeTicketActivityScores(population(), { asOf: AS_OF });
    for (const r of results) {
      if (!('scored' in r) || r.scored !== true) continue;
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
      expect(Number.isInteger(r.score)).toBe(true);
      expect(r.classification).toEqual(classify(r.score));
      expect(r.modelVersion).toEqual(MODEL_VERSION);
    }
  });

  it('refuses to score locations whose source quality is inadequate', () => {
    const inputs = [
      ...population(),
      makeLocation('poor', [40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40, 40], {
        dataConfidence: 0.2,
      }),
    ];
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    const poor = results.find((r) => r.locationId === 'poor');
    expect(poor).toMatchObject({ scored: false, reason: 'INSUFFICIENT_SOURCE_QUALITY' });
  });

  it('ranks a location that has no geometry, because ranking is not mapping', () => {
    // Camden publishes no coordinates. Refusing to rank a street on that basis
    // conflated "cannot be drawn on a map" with "cannot be ranked" and made the
    // whole hotspot ranking empty on real data. The score measures recorded
    // activity at a named location: street, counts and dates, no coordinate.
    const inputs = [
      ...population(),
      makeLocation('ungeocoded', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], {
        hasGeometry: false,
      }),
    ];
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    const ungeocoded = results.find((r) => r.locationId === 'ungeocoded');
    expect(ungeocoded?.scored).toBe(true);
  });

  it('scores a location identically whether or not it has geometry', () => {
    // Geometry must not influence the ranking at all — otherwise it is a hidden
    // input to a score that claims to measure enforcement activity.
    const counts = [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50];
    const withGeom = computeTicketActivityScores(
      [...population(), makeLocation('subject', counts, { hasGeometry: true })],
      { asOf: AS_OF },
    ).find((r) => r.locationId === 'subject');
    const withoutGeom = computeTicketActivityScores(
      [...population(), makeLocation('subject', counts, { hasGeometry: false })],
      { asOf: AS_OF },
    ).find((r) => r.locationId === 'subject');
    expect(withGeom).toEqual(withoutGeom);
  });

  it('still refuses a location whose source data is too poor to characterise', () => {
    // The confidence gate has to keep biting, or nothing does.
    const inputs = [
      ...population(),
      makeLocation('thin', [50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50, 50], {
        dataConfidence: 0.2,
      }),
    ];
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    expect(results.find((r) => r.locationId === 'thin')).toMatchObject({
      scored: false,
      reason: 'INSUFFICIENT_SOURCE_QUALITY',
    });
  });

  it('refuses to score locations below the minimum observation count', () => {
    const inputs = [...population(), makeLocation('sparse', [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])];
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    expect(results.find((r) => r.locationId === 'sparse')).toMatchObject({
      scored: false,
      reason: 'INSUFFICIENT_OBSERVATIONS',
    });
  });

  it('refuses to rank when the comparison population is too small', () => {
    const results = computeTicketActivityScores(
      [makeLocation('a', [10, 10, 10]), makeLocation('b', [20, 20, 20])],
      { asOf: AS_OF },
    );
    for (const r of results) {
      expect(r).toMatchObject({ scored: false, reason: 'NO_COMPARISON_POPULATION' });
    }
  });

  it('never treats data confidence as enforcement intensity — it shrinks toward the median', () => {
    const base = population();
    const highConfidenceBusiest = computeTicketActivityScores(base, { asOf: AS_OF });

    const lowered = base.map((l) =>
      l.locationId === 'busiest' ? { ...l, dataConfidence: 0.5 } : l,
    );
    const loweredResults = computeTicketActivityScores(lowered, { asOf: AS_OF });

    // Lower confidence on a high-activity location must reduce (not increase) how
    // strong a claim we make about it.
    expect(scored(loweredResults, 'busiest').score).toBeLessThan(
      scored(highConfidenceBusiest, 'busiest').score,
    );

    // And a low-activity location moves *up* toward the middle rather than down.
    const loweredQuiet = base.map((l) => (l.locationId === 'low' ? { ...l, dataConfidence: 0.5 } : l));
    expect(scored(computeTicketActivityScores(loweredQuiet, { asOf: AS_OF }), 'low').score)
      .toBeGreaterThan(scored(highConfidenceBusiest, 'low').score);
  });

  it('redistributes the window weight when no time filter is active', () => {
    const results = computeTicketActivityScores(population(), { asOf: AS_OF });
    const r = scored(results, 'mid');
    const windowComponent = r.components.find((c) => c.key === 'window');
    expect(windowComponent?.weight).toBe(0);
    expect(r.windowApplied).toBe(false);
    const totalWeight = r.components.reduce((acc, c) => acc + c.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5);
  });

  it('applies the window component when a time filter is active', () => {
    const peaky = population().map((l) =>
      l.locationId === 'mid'
        ? {
            ...l,
            temporal: {
              // All activity between 08:00 and 09:59.
              hourCounts: Array.from({ length: 24 }, (_, h) => (h === 8 || h === 9 ? 50 : 0)),
              dayOfWeekCounts: Array.from({ length: 7 }, () => 100 / 7),
            },
          }
        : l,
    );
    const filtered = computeTicketActivityScores(peaky, { asOf: AS_OF, window: { hours: [8, 9] } });
    const unfiltered = computeTicketActivityScores(peaky, { asOf: AS_OF });

    const f = scored(filtered, 'mid');
    expect(f.windowApplied).toBe(true);
    expect(f.components.find((c) => c.key === 'window')?.weight).toBe(
      DEFAULT_SCORING_CONFIG.weights.window,
    );
    expect(f.score).toBeGreaterThan(scored(unfiltered, 'mid').score);
  });

  it('damps trend for locations with very few observations', () => {
    // 2 → 6 PCNs is a 3x jump but on tiny counts; the trend component must stay near neutral.
    const inputs = [
      ...population(),
      makeLocation('spiky', [0, 0, 0, 0, 0, 0, 1, 1, 0, 2, 2, 2]),
    ];
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    const spiky = scored(results, 'spiky');
    const trend = spiky.components.find((c) => c.key === 'trend');
    expect(trend?.value).toBeGreaterThan(0.4);
    expect(trend?.value).toBeLessThan(0.75);
  });

  it('gives every scored location component weights summing to one', () => {
    const results = computeTicketActivityScores(population(), {
      asOf: AS_OF,
      window: { hours: [9, 10, 11] },
    });
    for (const r of results) {
      if (!('scored' in r) || r.scored !== true) continue;
      const total = r.components.reduce((acc, c) => acc + c.weight, 0);
      expect(total).toBeCloseTo(1, 5);
    }
  });

  it('returns one result per input, in input order', () => {
    const inputs = population();
    const results = computeTicketActivityScores(inputs, { asOf: AS_OF });
    expect(results).toHaveLength(inputs.length);
    expect(results.map((r) => r.locationId)).toEqual(inputs.map((i) => i.locationId));
  });
});
