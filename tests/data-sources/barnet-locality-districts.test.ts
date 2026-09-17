import { describe, expect, it } from 'vitest';
import {
  approvedLocalityDistricts,
  districtForBarnetLocality,
} from '@/data-sources/barnet/locality-districts';
import { matchStreet, type GazetteerEntry } from '@/data-sources/barnet/street-match';

/**
 * The reviewed locality table.
 *
 * Every entry was approved individually, so the list itself is pinned: adding
 * one without review should fail here, and so should removing one.
 */

const APPROVED: Readonly<Record<string, string>> = {
  'NORTH FINCHLEY': 'N12',
  'GOLDERS GREEN': 'NW11',
  WHETSTONE: 'N20',
  EDGWARE: 'HA8',
  'EAST FINCHLEY': 'N2',
  'THE HYDE': 'NW9',
  CRICKLEWOOD: 'NW2',
  'NEW SOUTHGATE': 'N11',
  'NEW BARNET': 'EN5',
};

describe('the approved table', () => {
  it('contains exactly the nine reviewed mappings', () => {
    expect(approvedLocalityDistricts()).toEqual(APPROVED);
  });

  it('does not contain the mappings that were reviewed and rejected', () => {
    /*
     * Mill Hill was measured and rejected: it would have resolved about 1,049
     * notices but broke HALE LANE, which straddles NW7/HA8 and which Ordnance
     * Survey files outside NW7 — turning a resolved street into a conflict.
     * Hendon and Finchley resolve nothing today and were left out rather than
     * shipped untested.
     */
    for (const absent of ['MILL HILL', 'HENDON', 'FINCHLEY']) {
      expect(approvedLocalityDistricts()[absent], absent).toBeUndefined();
      expect(districtForBarnetLocality(absent), absent).toBeNull();
    }
  });

  it('maps a listed locality and nothing else', () => {
    expect(districtForBarnetLocality('North Finchley')).toBe('N12');
    expect(districtForBarnetLocality('  golders green  ')).toBe('NW11');
    expect(districtForBarnetLocality('Whetstone')).toBe('N20');
  });

  it('returns null rather than guessing', () => {
    for (const unknown of ['Finchley Central', 'North', 'Barnet', '', null, undefined]) {
      expect(districtForBarnetLocality(unknown as string | null), String(unknown)).toBeNull();
    }
  });

  it('never strips a compass word to reach a listed locality', () => {
    /*
     * The inference this forbids is the tempting one: "North Whetstone" is not
     * Whetstone, and reaching N20 by deleting a word would be inventing a
     * correspondence the publisher never stated. Each of these would land on a
     * real table entry if a compass prefix were stripped, and each must not.
     */
    for (const derived of [
      'North Whetstone',
      'East Cricklewood',
      'South Edgware',
      'West Golders Green',
      'North New Barnet',
    ]) {
      expect(districtForBarnetLocality(derived), derived).toBeNull();
    }
  });

  it('never maps two localities onto one district', () => {
    // A many-to-one mapping would merge genuinely distinct roads.
    const districts = Object.values(approvedLocalityDistricts());
    expect(new Set(districts).size).toBe(districts.length);
  });
});

const entry = (over: Partial<GazetteerEntry> = {}): GazetteerEntry => ({
  id: 'osgb-1',
  name: 'High Road',
  kind: 'NAMED_ROAD',
  district: 'Barnet',
  postcodeDistrict: 'N12',
  populatedPlace: 'Finchley',
  longitude: -0.1727,
  latitude: 51.6153,
  ...over,
});

describe('the table in use', () => {
  // Ordnance Survey calls both of these "Finchley"; only the district separates
  // them, which is the whole reason the table exists.
  const twoHighRoads = [
    entry({ id: 'n12', postcodeDistrict: 'N12', populatedPlace: 'Finchley' }),
    entry({ id: 'n2', postcodeDistrict: 'N2', populatedPlace: 'Finchley' }),
  ];

  it('separates two roads that the gazetteer names identically', () => {
    const north = matchStreet('HIGH ROAD', twoHighRoads, {
      district: 'Barnet',
      locality: 'North Finchley',
      enforcementType: 'PARKING',
    });
    const east = matchStreet('HIGH ROAD', twoHighRoads, {
      district: 'Barnet',
      locality: 'East Finchley',
      enforcementType: 'PARKING',
    });
    expect(north.ok && north.entry.id).toBe('n12');
    expect(east.ok && east.entry.id).toBe('n2');
  });

  it('still refuses when the locality is not in the table', () => {
    const m = matchStreet('HIGH ROAD', twoHighRoads, {
      district: 'Barnet',
      locality: 'Mill Hill',
      enforcementType: 'PARKING',
    });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('AMBIGUOUS_NAME');
  });

  it("lets Barnet's own postcode win over the table", () => {
    // The table is consulted only where the publisher gave no district.
    const m = matchStreet('HIGH ROAD', twoHighRoads, {
      district: 'Barnet',
      locality: 'North Finchley',
      postcodeDistrict: 'N2',
      enforcementType: 'PARKING',
    });
    expect(m.ok && m.entry.id).toBe('n2');
  });

  it('refuses rather than forcing a match the gazetteer contradicts', () => {
    /*
     * HIGH STREET, Edgware in the real data: Barnet says Edgware, and Ordnance
     * Survey holds no HA8 High Street in Barnet. The mapping must produce a
     * stated conflict, not a nearest guess.
     */
    const m = matchStreet('HIGH STREET', [entry({ name: 'High Street', postcodeDistrict: 'EN5' })], {
      district: 'Barnet',
      locality: 'Edgware',
      enforcementType: 'PARKING',
    });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('POSTCODE_CONFLICT');
  });

  it('supplies no position, only a narrowing', () => {
    // A mapping can never introduce a candidate; it can only remove them.
    const m = matchStreet('HIGH ROAD', [], {
      district: 'Barnet',
      locality: 'North Finchley',
      enforcementType: 'PARKING',
    });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('NO_CANDIDATE');
  });
});
