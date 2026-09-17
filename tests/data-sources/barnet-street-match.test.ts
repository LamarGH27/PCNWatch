import { describe, expect, it } from 'vitest';
import { matchStreet, type GazetteerEntry } from '@/data-sources/barnet/street-match';

/**
 * The match decision.
 *
 * No gazetteer is bundled, so these run against hand-built candidate sets. That
 * is the right level for this: the thing being tested is the judgement — which
 * matches may be accepted — and it has to be settled before real data arrives
 * to be judged by it.
 *
 * Almost every test below asserts a refusal, which is the point. A street put
 * on the wrong road looks exactly like one put on the right road, and a reader
 * has no way to tell. Refusing is visible; being wrong is not.
 */

const entry = (over: Partial<GazetteerEntry> = {}): GazetteerEntry => ({
  id: 'osgb-1',
  name: 'Ballards Lane',
  kind: 'NAMED_ROAD',
  district: 'Barnet',
  postcodeDistrict: 'N3',
  longitude: -0.1936,
  latitude: 51.6006,
  ...over,
});

const opts = { district: 'Barnet', enforcementType: 'PARKING' } as const;

describe('accepted matches', () => {
  it('accepts exactly one official road of that name in the authority', () => {
    const m = matchStreet('BALLARDS LANE', [entry()], opts);
    expect(m.ok).toBe(true);
    if (m.ok) {
      expect(m.entry.id).toBe('osgb-1');
      expect(m.precision).toBe('STREET_REPRESENTATIVE_POINT');
    }
  });

  it('matches on the normalised name, so case and spacing do not matter', () => {
    for (const s of ['ballards lane', 'Ballards  Lane', 'BALLARDS LANE']) {
      expect(matchStreet(s, [entry()], opts).ok, s).toBe(true);
    }
  });

  it('uses the postcode district Barnet published to pick between same-name roads', () => {
    const m = matchStreet('BALLARDS LANE', [entry({ id: 'a', postcodeDistrict: 'N3' }), entry({ id: 'b', postcodeDistrict: 'N12' })], {
      ...opts,
      postcodeDistrict: 'N12',
    });
    expect(m.ok && m.entry.id).toBe('b');
  });

  it('prefers the whole road over its sections, which carry no stable id', () => {
    const m = matchStreet('BALLARDS LANE', [
      entry({ id: 'sec-1', kind: 'ROAD_SECTION' }),
      entry({ id: 'road', kind: 'NAMED_ROAD' }),
      entry({ id: 'sec-2', kind: 'ROAD_SECTION' }),
    ], opts);
    expect(m.ok && m.entry.id).toBe('road');
  });

  it('accepts several sections of one road when there is no road-level record', () => {
    // Sections of the same street are not competing places.
    const m = matchStreet('BALLARDS LANE', [entry({ id: 'only', kind: 'ROAD_SECTION' })], opts);
    expect(m.ok && m.entry.kind).toBe('ROAD_SECTION');
  });
});

describe('refusals', () => {
  it('refuses when no road of that name exists', () => {
    const m = matchStreet('NOWHERE STREET', [entry()], opts);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('NO_CANDIDATE');
  });

  it('refuses a right-name road in the wrong borough', () => {
    /*
     * The most likely way this produces a confidently wrong point: "Station
     * Road" and "High Road" exist in most London boroughs.
     */
    const m = matchStreet('STATION ROAD', [entry({ name: 'Station Road', district: 'Camden' })], opts);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('OUTSIDE_AUTHORITY');
  });

  it('refuses two genuinely different roads of the same name in Barnet', () => {
    const m = matchStreet('STATION ROAD', [
      entry({ id: 'a', name: 'Station Road', postcodeDistrict: 'HA8' }),
      entry({ id: 'b', name: 'Station Road', postcodeDistrict: 'EN5' }),
    ], opts);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('AMBIGUOUS_NAME');
  });

  it('refuses when Barnet and the gazetteer disagree about the postcode district', () => {
    const m = matchStreet('BALLARDS LANE', [entry({ postcodeDistrict: 'NW11' })], { ...opts, postcodeDistrict: 'N3' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('POSTCODE_CONFLICT');
  });

  it('never selects the first candidate to break a tie', () => {
    // The failure this exists to prevent, stated directly.
    const m = matchStreet('STATION ROAD', [
      entry({ id: 'first', name: 'Station Road', postcodeDistrict: null }),
      entry({ id: 'second', name: 'Station Road', postcodeDistrict: null }),
    ], opts);
    expect(m.ok).toBe(false);
  });

  it('refuses every location class that is not an ordinary street', () => {
    for (const [loc, feed] of [
      ['Lodge Lane Car Park', 'PARKING'],
      ['Finchley Road into Briardale Gardens (NW2)', 'MOVING_TRAFFIC'],
      ['NETHERLANDS RD (EN5)', 'MOVING_TRAFFIC'],
      ['', 'PARKING'],
    ] as const) {
      const m = matchStreet(loc, [entry({ name: loc })], { district: 'Barnet', enforcementType: feed });
      expect(m.ok, loc).toBe(false);
      if (!m.ok) expect(m.refusal).toBe('NOT_ELIGIBLE_CLASS');
    }
  });

  it('refuses an entry of the right name that is not a road', () => {
    const m = matchStreet('BALLARDS LANE', [entry({ kind: 'OTHER' })], opts);
    expect(m.ok).toBe(false);
  });

  it('gives every refusal a reason naming what went wrong', () => {
    const m = matchStreet('STATION ROAD', [entry({ name: 'Station Road', district: 'Camden' })], opts);
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.reason).toContain('Barnet');
  });
});

describe('no fuzzy matching anywhere', () => {
  it('refuses names that merely look similar', () => {
    for (const near of ['BALLARD LANE', 'BALLARDS LANE NORTH', 'BALLARDS CLOSE', 'BALLARDS']) {
      const m = matchStreet(near, [entry()], opts);
      expect(m.ok, near).toBe(false);
    }
  });
});
