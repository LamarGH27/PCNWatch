import { describe, expect, it } from 'vitest';
import { OS_COLUMN, OS_COLUMN_COUNT, ROAD_LOCAL_TYPES } from '@/data-sources/barnet/gazetteer';
import { joinKey, matchStreet, type GazetteerEntry } from '@/data-sources/barnet/street-match';
import { bngToWgs84 } from '@/core/geography/osgb';
import { splitLocation } from '@/data-sources/barnet/schema';

/**
 * Reading OS Open Names, and joining Barnet's street names to it.
 *
 * The gazetteer itself is an Ordnance Survey download and is not bundled, so
 * what is pinned here is everything that would silently produce wrong points if
 * it drifted: the positional schema, the coordinate transform, and the two
 * normalisations that let two publishers' spellings of one street agree.
 */

describe('the OS Open Names schema', () => {
  it('pins the column positions the product publishes', () => {
    /*
     * OS Open Names CSVs carry no header row — the column order *is* the
     * schema, published separately as OS_Open_Names_Header.csv. These positions
     * are taken from that file. Reading NAME1 from the wrong index would give
     * every road a plausible wrong name and nothing downstream would notice.
     */
    expect(OS_COLUMN_COUNT).toBe(34);
    expect(OS_COLUMN).toEqual({
      ID: 0,
      NAME1: 2,
      TYPE: 6,
      LOCAL_TYPE: 7,
      GEOMETRY_X: 8,
      GEOMETRY_Y: 9,
      POSTCODE_DISTRICT: 16,
      POPULATED_PLACE: 18,
      DISTRICT_BOROUGH: 21,
      COUNTY_UNITARY: 24,
    });
  });

  it('treats only named roads as roads', () => {
    expect(ROAD_LOCAL_TYPES['Named Road']).toBe('NAMED_ROAD');
    expect(ROAD_LOCAL_TYPES['Section Of Named Road']).toBe('ROAD_SECTION');
    // A numbered road's NAME1 is "A41", which is not what Barnet calls a street.
    expect(ROAD_LOCAL_TYPES['Numbered Road']).toBeUndefined();
    expect(ROAD_LOCAL_TYPES['Postcode']).toBeUndefined();
  });
});

describe('the coordinate transform', () => {
  it('converts British National Grid to WGS84', () => {
    // Ordnance Survey publishes eastings and northings; the map draws degrees.
    const p = bngToWgs84(524765, 190552);
    expect(p.latitude).toBeCloseTo(51.6, 3);
    expect(p.longitude).toBeCloseTo(-0.2, 3);
  });

  it('places a Barnet easting in Barnet, not in the Atlantic', () => {
    // The failure a missing transform produces: an easting read as a longitude.
    const p = bngToWgs84(528087, 196199);
    expect(p.latitude).toBeGreaterThan(51.5);
    expect(p.latitude).toBeLessThan(51.8);
    expect(p.longitude).toBeGreaterThan(-0.4);
    expect(p.longitude).toBeLessThan(0);
  });
});

describe('the join key', () => {
  it('lets two publishers spell one street differently', () => {
    // Barnet writes REGENTS PARK ROAD; Ordnance Survey writes Regent's Park
    // Road. 58 Barnet locations failed to match for no other reason.
    expect(joinKey('REGENTS PARK ROAD')).toBe(joinKey("Regent's Park Road"));
    expect(joinKey('ST MARYS CRESCENT')).toBe(joinKey("St Mary's Crescent"));
    expect(joinKey('DEANS LANE')).toBe(joinKey("Dean's Lane"));
  });

  it('still refuses genuinely different names', () => {
    expect(joinKey('BALLARDS LANE')).not.toBe(joinKey('BALLARD LANE'));
    expect(joinKey('HIGH ROAD')).not.toBe(joinKey('HIGH STREET'));
  });
});

describe('locality is part of a location, not decoration', () => {
  it('keeps a locality qualifier and strips a postcode one', () => {
    /*
     * "BALLARDS LANE, N3" and "BALLARDS LANE, N12" are one road crossing a
     * district boundary. "HIGH ROAD, North Finchley" and "HIGH ROAD, Whetstone"
     * are two different roads carrying 15,144 and 8,417 notices — merging them
     * would add two roads' enforcement together and rank the total as one place.
     */
    expect(splitLocation('BALLARDS LANE, N3')).toEqual({
      street: 'BALLARDS LANE',
      postcodeDistrict: 'N3',
      locality: null,
    });
    expect(splitLocation('HIGH ROAD, North Finchley')).toEqual({
      street: 'HIGH ROAD',
      postcodeDistrict: null,
      locality: 'North Finchley',
    });
  });
});

const entry = (over: Partial<GazetteerEntry> = {}): GazetteerEntry => ({
  id: 'osgb-1',
  name: 'Station Road',
  kind: 'NAMED_ROAD',
  district: 'Barnet',
  postcodeDistrict: 'HA8',
  populatedPlace: 'Edgware',
  longitude: -0.275,
  latitude: 51.613,
  ...over,
});

describe('locality disambiguation', () => {
  const both = [
    entry({ id: 'edgware', populatedPlace: 'Edgware', postcodeDistrict: 'HA8' }),
    entry({ id: 'barnet', populatedPlace: 'Barnet', postcodeDistrict: 'EN5' }),
  ];

  it('picks the road whose populated place Barnet named', () => {
    const m = matchStreet('STATION ROAD', both, {
      district: 'Barnet',
      locality: 'Edgware',
      enforcementType: 'PARKING',
    });
    expect(m.ok && m.entry.id).toBe('edgware');
  });

  it('still refuses when the locality does not separate them', () => {
    const m = matchStreet('STATION ROAD', both, { district: 'Barnet', enforcementType: 'PARKING' });
    expect(m.ok).toBe(false);
    if (!m.ok) expect(m.refusal).toBe('AMBIGUOUS_NAME');
  });

  it('falls back rather than refusing when a locality matches nothing', () => {
    // Barnet says "North Finchley"; Ordnance Survey says "Finchley". A spelling
    // the gazetteer does not share is a reason to try the postcode, not to give
    // up — and if neither separates them, the ambiguity refusal still stands.
    const m = matchStreet('STATION ROAD', both, {
      district: 'Barnet',
      locality: 'Somewhere Else',
      postcodeDistrict: 'EN5',
      enforcementType: 'PARKING',
    });
    expect(m.ok && m.entry.id).toBe('barnet');
  });
});
