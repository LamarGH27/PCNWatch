import { describe, expect, it } from 'vitest';
import { classifyBarnetLocation, isCameraFeed } from '@/data-sources/barnet/location-class';

/**
 * Location classes.
 *
 * Every string below is a real Barnet value taken from the published files, and
 * the test that matters most is not that a street is recognised — it is that
 * everything which is not a street is refused before a gazetteer is consulted.
 */

const cls = (s: string, feed?: string) => classifyBarnetLocation(s, feed).class;
const eligible = (s: string, feed?: string) => classifyBarnetLocation(s, feed).eligibleForNameMatch;

describe('ordinary streets', () => {
  it('accepts a plain parking street', () => {
    for (const s of ['GOLDERS GREEN ROAD', 'STATION ROAD', 'Hale Lane', 'THE BROADWAY']) {
      expect(cls(s, 'PARKING'), s).toBe('ORDINARY_STREET');
      expect(eligible(s, 'PARKING'), s).toBe(true);
    }
  });
});

describe('car parks are refused', () => {
  it('refuses a car park even when it is named after a street', () => {
    /*
     * The error this prevents: "Lodge Lane Car Park" matching Lodge Lane would
     * put every off-street notice on the road outside it. Tested before every
     * other rule for that reason.
     */
    for (const s of ['Lodge Lane Car Park', 'Stanhope Road Car Park (MAIN)', 'Bunns Lane Car Park']) {
      expect(cls(s, 'PARKING'), s).toBe('CAR_PARK');
      expect(eligible(s, 'PARKING'), s).toBe(false);
    }
  });
});

describe('junctions are refused', () => {
  it('refuses every way Barnet writes a junction', () => {
    const junctions = [
      'A5 Cricklewood Broadway junct. with Kara Way(NW2)',
      'A5 CRICKLEWOOD BROADWAY /JUNC/W DEPOT APPROACH NW2',
      'TILLING RD Junction Brentfield Gardens (NW2)',
      'Finchley Road into Briardale Gardens (NW2)',
      'A5 THE HYDE/WEST HENDON BROADWAY (NW9)',
    ];
    for (const s of junctions) {
      expect(eligible(s, 'MOVING_TRAFFIC'), s).toBe(false);
      expect(cls(s, 'MOVING_TRAFFIC'), s).toBe('JUNCTION');
    }
  });
});

describe('described segments are refused', () => {
  it('refuses a point described along a road', () => {
    const segments = [
      'A5 THE HYDE/ 20M NORTH OF J/W HYDE ESTATE ROAD NW9',
      'A5 EDGWARE ROAD / CRICKLEWOOD BROADWAY O/S NO. 400 (NW2)',
      'A5 The Hyde between The Greenway& Annesley Av(NW9)',
      'Everglade Strand, Eastbound, NW9',
      'STATION ROAD, EDGWARE, BUS STATION ENTRANCE (NORTHBOUND)',
      'The Fairway, From Ellesmere Avenue (NW7)',
    ];
    for (const s of segments) {
      expect(eligible(s, 'MOVING_TRAFFIC'), s).toBe(false);
    }
  });
});

describe('described segments in the parking feed are refused too', () => {
  it('refuses a parking location that describes a stretch rather than a street', () => {
    /*
     * These are the only five, carrying 76 notices, and they are the ones the
     * camera-feed rule does not already cover — so they are what actually tests
     * the descriptive rule. An access road running "FROM GREENLANDS LANE TO
     * ASHLEY LANE" is not Greenlands Lane and not Ashley Lane.
     */
    const parkingSegments = [
      'GREAT NORTH WAY ACCESS ROAD 3 - FROM GREENLANDS LANE TO ASHLEY LANE',
      'HIGH ROAD NORTH FINCHLEY ACCESS TO NUMBERS 421 TO 437',
      'OLD RECTORY GARDENS to RECTORY LANE through route',
      'THE BURROUGHS ACCESS ROAD BETWEEN FIRE STATION AND LIBRARY',
      'COLNEY HATCH LANE SERVICE ROAD TO NOS 121 TO 133',
    ];
    for (const s of parkingSegments) {
      expect(cls(s, 'PARKING'), s).toBe('DESCRIPTIVE_SEGMENT');
      expect(eligible(s, 'PARKING'), s).toBe(false);
    }
  });
});

describe('camera feeds are never matched to a street', () => {
  it('refuses a camera site even when it reads as a bare street name', () => {
    /*
     * The finding this encodes: 41 moving traffic sites carrying 33,391 notices
     * parse as ordinary street names. A camera sits at one point on a street
     * and the file does not say where, so the street is not a fair position
     * for the notice — however plainly the site happens to be written.
     */
    for (const s of ['NETHERLANDS RD (EN5)', 'Torrington Park (N12)']) {
      expect(cls(s, 'MOVING_TRAFFIC'), s).toBe('CAMERA_SITE');
      expect(eligible(s, 'MOVING_TRAFFIC'), s).toBe(false);
      expect(eligible(s, 'BUS_LANE'), s).toBe(false);
      // The same text from the parking feed is an ordinary street.
      expect(eligible(s, 'PARKING'), s).toBe(true);
    }
  });

  it('knows which feeds are camera feeds', () => {
    expect(isCameraFeed('BUS_LANE')).toBe(true);
    expect(isCameraFeed('MOVING_TRAFFIC')).toBe(true);
    expect(isCameraFeed('PARKING')).toBe(false);
  });
});

describe('fails closed', () => {
  it('refuses an empty location', () => {
    expect(eligible('')).toBe(false);
    expect(eligible('   ')).toBe(false);
    expect(cls('')).toBe('UNCLASSIFIED');
  });

  it('always gives a reason an operator can act on', () => {
    for (const s of ['Lodge Lane Car Park', 'Finchley Road into X', '', 'GOLDERS GREEN ROAD']) {
      expect(classifyBarnetLocation(s, 'PARKING').reason.length).toBeGreaterThan(20);
    }
  });

  it('never marks anything but an ordinary street eligible', () => {
    const samples: Array<[string, string]> = [
      ['Lodge Lane Car Park', 'PARKING'],
      ['Finchley Road into Briardale Gardens (NW2)', 'MOVING_TRAFFIC'],
      ['A5 The Hyde between The Greenway & Annesley Av (NW9)', 'BUS_LANE'],
      ['NETHERLANDS RD (EN5)', 'MOVING_TRAFFIC'],
      ['', 'PARKING'],
    ];
    for (const [s, feed] of samples) {
      const c = classifyBarnetLocation(s, feed);
      if (c.eligibleForNameMatch) expect(c.class).toBe('ORDINARY_STREET');
      else expect(c.class).not.toBe('ORDINARY_STREET');
    }
  });
});
