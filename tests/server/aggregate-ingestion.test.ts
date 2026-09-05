import { describe, expect, it } from 'vitest';
import { ActivityAccumulator } from '@/server/ingestion/postgres/aggregate';
import { periodStartFor } from '@/server/ingestion/postgres/aggregate-run';
import type { NormalisedPcnEvent } from '@/data-sources/shared/types';

function ev(overrides: Partial<NormalisedPcnEvent> = {}): NormalisedPcnEvent {
  return {
    sourceRecordId: 'X1',
    authoritySlug: 'camden',
    contraventionCode: '12',
    enforcementType: 'PARKING',
    issuedDate: '2026-06-01',
    issuedAt: '2026-06-01T09:14:00.000Z',
    issuedHour: 9,
    issuedDayOfWeek: 1,
    streetName: 'MAPLE STREET W1',
    streetNameNormalised: 'maple street w1',
    locationSlug: 'maple-street-w1',
    locality: 'CA-E',
    postcodeDistrict: 'W1',
    longitude: null,
    latitude: null,
    dataConfidence: 0.9,
    sourceMetadata: {},
    rowHash: 'h',
    ...overrides,
  };
}

describe('counting notices instead of storing them', () => {
  it('collapses many notices into one cell', () => {
    // The whole point: forty notices on one street, one day, one code is one
    // row. The old model wrote forty.
    const acc = new ActivityAccumulator();
    for (let i = 0; i < 40; i++) acc.add(ev({ sourceRecordId: `R${i}` }));

    expect(acc.cellCount).toBe(1);
    expect(acc.totalCounted).toBe(40);
    const [cell] = acc.drain().cells;
    expect(cell!.pcnCount).toBe(40);
  });

  it('separates cells by every dimension that must stay filterable', () => {
    const acc = new ActivityAccumulator();
    acc.add(ev());
    acc.add(ev({ issuedDate: '2026-06-02' }));
    acc.add(ev({ contraventionCode: '33' }));
    acc.add(ev({ enforcementType: 'MOVING_TRAFFIC' }));
    acc.add(ev({ locationSlug: 'judd-street-wc1' }));
    expect(acc.cellCount).toBe(5);
  });

  it('reconciles: every notice counted exactly once', () => {
    const acc = new ActivityAccumulator();
    const codes = ['12', '33', '11', null];
    for (let i = 0; i < 500; i++) {
      acc.add(
        ev({
          sourceRecordId: `R${i}`,
          contraventionCode: codes[i % codes.length] ?? null,
          issuedDate: `2026-06-${String(1 + (i % 28)).padStart(2, '0')}`,
          issuedHour: i % 24,
        }),
      );
    }
    const total = acc.drain().cells.reduce((sum, c) => sum + c.pcnCount, 0);
    expect(total).toBe(500);
    expect(acc.totalCounted).toBe(500);
  });

  it('builds an hour histogram that reconciles with the count', () => {
    const acc = new ActivityAccumulator();
    for (let i = 0; i < 100; i++) acc.add(ev({ sourceRecordId: `R${i}`, issuedHour: i % 24 }));
    const [cell] = acc.drain().cells;
    expect(cell!.hourHistogram).toHaveLength(24);
    expect(cell!.hourHistogram.reduce((a, b) => a + b, 0)).toBe(cell!.pcnCount);
  });

  it('counts a notice with no time, and gives it no hour', () => {
    // The histogram total is legitimately lower than the count when the source
    // gave no time. That difference must not silently become a lost notice.
    const acc = new ActivityAccumulator();
    acc.add(ev({ issuedHour: null }));
    acc.add(ev({ sourceRecordId: 'R2', issuedHour: 9 }));
    const [cell] = acc.drain().cells;
    expect(cell!.pcnCount).toBe(2);
    expect(cell!.hourHistogram.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('finds the peak hour from the histogram alone', () => {
    // Reproducible from stored numbers: no individual notice is kept to answer
    // "most enforcement happened between 10:00 and 11:00".
    const acc = new ActivityAccumulator();
    for (let i = 0; i < 30; i++) acc.add(ev({ sourceRecordId: `A${i}`, issuedHour: 10 }));
    for (let i = 0; i < 5; i++) acc.add(ev({ sourceRecordId: `B${i}`, issuedHour: 14 }));
    const [cell] = acc.drain().cells;
    const peak = cell!.hourHistogram.indexOf(Math.max(...cell!.hourHistogram));
    expect(peak).toBe(10);
  });

  it('keeps a street placeable once any notice can place it', () => {
    // The bug that left 8,774 positioned notices unplaced: the decision must be
    // made across the whole run, not per batch.
    const acc = new ActivityAccumulator();
    for (let i = 0; i < 20; i++) acc.add(ev({ sourceRecordId: `U${i}` }));
    acc.add(ev({ sourceRecordId: 'P', longitude: -0.1084, latitude: 51.5205 }));

    const [location] = acc.drain().locations;
    expect(location!.longitude).toBeCloseTo(-0.1084, 4);
    expect(location!.geometrySource).toBe('SOURCE_PUBLISHED');
    expect(location!.geometryMethod).toBe('REPRESENTATIVE_EVENT');
    expect(location!.geometryFromRecordId).toBe('P');
  });

  it('keeps the first position found, so a re-run places a street identically', () => {
    const acc = new ActivityAccumulator();
    acc.add(ev({ sourceRecordId: 'FIRST', longitude: -0.10, latitude: 51.52 }));
    acc.add(ev({ sourceRecordId: 'SECOND', longitude: -0.20, latitude: 51.60 }));
    const [location] = acc.drain().locations;
    expect(location!.longitude).toBeCloseTo(-0.10, 4);
    expect(location!.geometryFromRecordId).toBe('FIRST');
  });

  it('forgets cells on flush but never forgets a positioned street', () => {
    // Cells merge in the database so dropping them is safe; dropping locations
    // would reintroduce the batch-order bug.
    const acc = new ActivityAccumulator();
    acc.add(ev({ sourceRecordId: 'P', longitude: -0.1084, latitude: 51.5205 }));
    acc.clearCells();
    acc.add(ev({ sourceRecordId: 'LATER' }));

    const drained = acc.drain();
    expect(drained.cells).toHaveLength(1);
    expect(drained.locations).toHaveLength(1);
    expect(drained.locations[0]!.longitude).toBeCloseTo(-0.1084, 4);
  });

  it('claims a CCTV channel only when it holds for every notice in the cell', () => {
    const mixed = new ActivityAccumulator();
    mixed.add(ev({ sourceMetadata: { _viaCctv: true } }));
    mixed.add(ev({ sourceRecordId: 'R2', sourceMetadata: { _viaCctv: false } }));
    expect(mixed.drain().cells[0]!.viaCctv).toBeNull();

    const uniform = new ActivityAccumulator();
    uniform.add(ev({ sourceMetadata: { _viaCctv: true } }));
    uniform.add(ev({ sourceRecordId: 'R2', sourceMetadata: { _viaCctv: true } }));
    expect(uniform.drain().cells[0]!.viaCctv).toBe(true);
  });

  it('produces the same cells whatever order the notices arrive in', () => {
    // Pages come back from the source in whatever order it feels like, and a
    // re-run may page differently. The published dataset must not depend on it.
    const notices = Array.from({ length: 200 }, (_, i) =>
      ev({
        sourceRecordId: `R${i}`,
        issuedDate: `2026-06-${String((i % 28) + 1).padStart(2, '0')}`,
        contraventionCode: ['01', '12', '21'][i % 3]!,
        issuedHour: 8 + (i % 8),
        locationSlug: ['maple-street-w1', 'oak-road-nw5'][i % 2]!,
      }),
    );

    const forwards = new ActivityAccumulator();
    for (const n of notices) forwards.add(n);

    const backwards = new ActivityAccumulator();
    for (const n of [...notices].reverse()) backwards.add(n);

    const shape = (acc: ActivityAccumulator) =>
      acc
        .drain()
        .cells.map((c) => ({
          key: `${c.locationSlug} ${c.activityDate} ${c.contraventionCode} ${c.enforcementClass}`,
          count: c.pcnCount,
          hours: c.hourHistogram.join(','),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));

    expect(shape(backwards)).toEqual(shape(forwards));
  });

  it('keeps memory bounded by distinct cells, not by notices', () => {
    const acc = new ActivityAccumulator();
    for (let i = 0; i < 20_000; i++) acc.add(ev({ sourceRecordId: `R${i}` }));
    expect(acc.totalCounted).toBe(20_000);
    expect(acc.cellCount).toBe(1);
  });
});

describe('period windows are exact days, not months', () => {
  // Month-aligned windows made a "30 day" figure cover up to 60. The daily model
  // has no reason to approximate.
  it('gives exactly the trailing window', () => {
    expect(periodStartFor('30D', '2026-06-30')).toBe('2026-06-01');
    expect(periodStartFor('90D', '2026-06-30')).toBe('2026-04-02');
    expect(periodStartFor('12M', '2026-06-30')).toBe('2025-07-01');
  });

  it('does not round to a month boundary', () => {
    // Mid-month: a month-aligned implementation would answer 2026-06-01 here.
    expect(periodStartFor('30D', '2026-06-15')).toBe('2026-05-17');
  });

  it('gives a different start per period, and is deterministic', () => {
    const p30 = periodStartFor('30D', '2026-06-15');
    const p90 = periodStartFor('90D', '2026-06-15');
    const p12 = periodStartFor('12M', '2026-06-15');
    expect(new Set([p30, p90, p12]).size).toBe(3);
    expect(p30 > p90).toBe(true);
    expect(p90 > p12).toBe(true);
    expect(periodStartFor('30D', '2026-06-15')).toBe(p30);
  });
});
