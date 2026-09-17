import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assignOrdinals,
  barnetRecordId,
  createBarnetAdapter,
  decodeCsv,
  normaliseBarnetRow,
  parseCsv,
  readFeed,
  BarnetFetchError,
  BARNET_SOURCE,
  type BarnetRawRow,
} from '@/data-sources/barnet/adapter';
import { feedFor, BARNET_FEEDS } from '@/data-sources/barnet/feeds';
import {
  isWarningNotice,
  parseBarnetContravention,
  splitLocation,
  RETAINABLE_METADATA_FIELDS,
} from '@/data-sources/barnet/schema';
import { CAMDEN_SOURCE } from '@/data-sources/camden/adapter';
import { getSource, knownSourceSlugs, requireSource } from '@/data-sources/registry';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import { authorityArea, isWithinCoverage, COVERED_AUTHORITY_NAME } from '@/core/coverage/area';

/**
 * Barnet ingestion.
 *
 * Written against the shapes the real files actually have — both header
 * variants, both encodings, the warning-notice suffix, the two different
 * meanings of a comma — rather than against the dataset documentation, which
 * describes none of those things.
 */

const dir = mkdtempSync(join(tmpdir(), 'barnet-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const PARKING_HEADER = 'Time,Date,,Contravention,Street,Day,Hour,Blank 2,Date 2';
const CAMERA_HEADER = 'Issue time,Issue Date,Column1,Contravention,Location,Day,Hour,Column2,Date picker';

function write(name: string, lines: readonly string[], encoding: BufferEncoding = 'utf8'): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join('\n'), encoding);
  return path;
}

const parkingRow = (date: string, time: string, street: string, code: string) =>
  `${time},${date},,${code},${street},Monday,${time.slice(0, 2)},,${date}`;
const cameraRow = (date: string, time: string, loc: string, code: string) =>
  `${time},${date},,${code},${loc},Monday,${time.slice(0, 2)},,${date}`;

function raw(feedKey: 'PARKING' | 'BUS_LANE' | 'MOVING_TRAFFIC', over: Partial<BarnetRawRow> = {}): BarnetRawRow {
  return {
    feed: feedFor(feedKey),
    date: '01/07/2025',
    time: '09:15:00',
    location: 'BALLARDS LANE',
    contravention: '01 - Parked in a restricted street during prescribed hours',
    ...over,
  };
}

/* ---------------------------------------------------------------- */
/* Schema parsing                                                    */
/* ---------------------------------------------------------------- */

describe('Barnet CSV parsing', () => {
  it('reads both published header variants', () => {
    const p = write('p.csv', [PARKING_HEADER, parkingRow('01/07/2025', '09:15:00', 'BALLARDS LANE', '01 - Parked')]);
    const c = write('c.csv', [CAMERA_HEADER, cameraRow('01/07/2025', '09:15:00', 'A5 The Hyde (NW9)', '34J - Being in a bus lane')]);
    expect(readFeed(feedFor('PARKING'), [p])).toHaveLength(1);
    expect(readFeed(feedFor('BUS_LANE'), [c])).toHaveLength(1);
  });

  it('decodes the Windows-1252 bus lane file without mangling a UTF-8 one', () => {
    // 0x96 is an en dash in cp1252 and not valid UTF-8 at all. The real Bus
    // Lane file contains 890 of them; reading it as UTF-8 throws.
    expect(decodeCsv(Buffer.from([0x41, 0x96, 0x42]))).toEqual({ text: 'A–B', encoding: 'cp1252' });
    expect(decodeCsv(Buffer.from('A—B', 'utf8')).encoding).toBe('utf-8');
    // A BOM is stripped rather than becoming part of the first column name.
    expect(decodeCsv(Buffer.from('﻿Time,Date', 'utf8')).text).toBe('Time,Date');
  });

  it('treats every partition as the same file and refuses a mismatched header', () => {
    const a = write('a1.csv', [PARKING_HEADER, parkingRow('01/07/2025', '09:15:00', 'A ROAD', '01 - x')]);
    const b = write('a2.csv', [PARKING_HEADER, parkingRow('02/07/2025', '09:15:00', 'B ROAD', '01 - x')]);
    expect(readFeed(feedFor('PARKING'), [a, b])).toHaveLength(2);

    const wrong = write('a3.csv', ['Time,Date,,Contravention,Road,Day,Hour,Blank 2,Date 2', parkingRow('03/07/2025', '09:15:00', 'C ROAD', '01 - x')]);
    expect(() => readFeed(feedFor('PARKING'), [a, wrong])).toThrow(BarnetFetchError);
  });

  it('refuses a file whose column count is not the published one', () => {
    const short = write('short.csv', ['Time,Date,Contravention', '09:15:00,01/07/2025,01 - x']);
    expect(() => readFeed(feedFor('PARKING'), [short])).toThrow(/expected 9/);
  });

  it('refuses a feed with no files rather than ingesting nothing quietly', () => {
    expect(() => readFeed(feedFor('PARKING'), [])).toThrow(/No files configured/);
  });

  it('keeps a quoted comma inside its field', () => {
    expect(parseCsv('a,"b,c",d')).toEqual([['a', 'b,c', 'd']]);
    expect(parseCsv('a,b\r\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

/* ---------------------------------------------------------------- */
/* Enforcement classification                                        */
/* ---------------------------------------------------------------- */

describe('enforcement classification', () => {
  it('takes the class from the dataset, never from the code', () => {
    // Barnet's own datasets are the authority on which regime issued a notice.
    // Code 01 in the bus lane feed is still a bus lane matter, not parking.
    for (const [key, expected] of [['PARKING', 'PARKING'], ['BUS_LANE', 'BUS_LANE'], ['MOVING_TRAFFIC', 'MOVING_TRAFFIC']] as const) {
      const r = normaliseBarnetRow(raw(key), 1, 0);
      expect(r.result.ok && r.result.event.enforcementType).toBe(expected);
    }
  });

  it('never produces UNKNOWN from a recognised feed', () => {
    for (const feed of BARNET_FEEDS) expect(feed.enforcementClass).not.toBe('UNKNOWN');
  });

  it('reads the code and suffix, and tolerates a missing dash', () => {
    expect(parseBarnetContravention('34J - Being in a bus lane')).toEqual({ code: '34', suffix: 'J', full: '34J' });
    expect(parseBarnetContravention('51J Failing to comply with a no entry sign (cam)')).toEqual({ code: '51', suffix: 'J', full: '51J' });
    expect(parseBarnetContravention('01 - Parked in a restricted street')).toEqual({ code: '01', suffix: null, full: '01' });
    expect(parseBarnetContravention('nonsense')).toEqual({ code: null, suffix: null, full: null });
  });

  it('keys on the code, because the description is not stable', () => {
    // The same contravention ships with a real apostrophe and with a mangled
    // one, in the same file: "person's" and "person?s".
    const a = parseBarnetContravention("40 - Parked in a designated disabled person's parking place");
    const b = parseBarnetContravention('40 - Parked in a designated disabled person?s parking place');
    expect(a.full).toBe(b.full);
  });
});

/* ---------------------------------------------------------------- */
/* Warning notices                                                   */
/* ---------------------------------------------------------------- */

describe('warning notices', () => {
  it('identifies them by suffix, deterministically', () => {
    expect(isWarningNotice(parseBarnetContravention('34W - Being in a bus lane'))).toBe(true);
    expect(isWarningNotice(parseBarnetContravention('34J - Being in a bus lane'))).toBe(false);
    expect(isWarningNotice(parseBarnetContravention('34 - Being in a bus lane'))).toBe(false);
  });

  it('excludes them from penalty charge events and says so', () => {
    const out = normaliseBarnetRow(raw('BUS_LANE', { contravention: '34W - Being in a bus lane' }), 7, 0);
    expect(out.warningNotice).toBe(true);
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.errorCode).toBe('WARNING_NOTICE');
  });

  it('does not report an ordinary notice as a warning', () => {
    const out = normaliseBarnetRow(raw('BUS_LANE', { contravention: '34J - Being in a bus lane' }), 8, 0);
    expect(out.warningNotice).toBe(false);
    expect(out.result.ok).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/* Record identity                                                   */
/* ---------------------------------------------------------------- */

describe('record identity', () => {
  const same = () => raw('MOVING_TRAFFIC', { location: 'A5 The Hyde (NW9)', contravention: '31J - Box Junction (cam)' });

  it('keeps two notices that agree on every published field', () => {
    /*
     * The failure this prevents: Barnet records time to the minute, and several
     * vehicles genuinely are caught at one box junction inside one minute.
     * Hashing the four published fields alone would discard 49,217 real rows
     * across the three feeds, concentrated at the busiest locations.
     */
    const rows = [same(), same(), same()];
    const ordinals = assignOrdinals(rows);
    expect(ordinals).toEqual([0, 1, 2]);
    const ids = rows.map((r, i) => barnetRecordId(r, ordinals[i] as number));
    expect(new Set(ids).size).toBe(3);
  });

  it('is deterministic: the same input always yields the same ids', () => {
    const a = [same(), same()];
    const b = [same(), same()];
    expect(assignOrdinals(a).map((o, i) => barnetRecordId(a[i] as BarnetRawRow, o)))
      .toEqual(assignOrdinals(b).map((o, i) => barnetRecordId(b[i] as BarnetRawRow, o)));
  });

  it('is stable when later rows are appended, which is how Barnet refreshes', () => {
    const first = [same(), same()];
    const later = [same(), same(), same()];
    const idsFirst = assignOrdinals(first).map((o, i) => barnetRecordId(first[i] as BarnetRawRow, o));
    const idsLater = assignOrdinals(later).map((o, i) => barnetRecordId(later[i] as BarnetRawRow, o));
    expect(idsLater.slice(0, 2)).toEqual(idsFirst);
  });

  it('separates rows that differ in any field, including the feed', () => {
    const base = raw('PARKING');
    const ids = new Set([
      barnetRecordId(base, 0),
      barnetRecordId({ ...base, date: '02/07/2025' }, 0),
      barnetRecordId({ ...base, time: '09:16:00' }, 0),
      barnetRecordId({ ...base, location: 'OTHER ROAD' }, 0),
      barnetRecordId({ ...base, contravention: '02 - x' }, 0),
      barnetRecordId({ ...base, feed: feedFor('BUS_LANE') }, 0),
    ]);
    expect(ids.size).toBe(6);
  });

  it('is built from nothing identifying', () => {
    // No PCN number and no registration exists in the source, and the identity
    // must never become a reason to want one.
    const id = barnetRecordId(raw('PARKING'), 0);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

/* ---------------------------------------------------------------- */
/* Location handling                                                 */
/* ---------------------------------------------------------------- */

describe('location handling', () => {
  it('lifts a district off a parking street so one street ranks once', () => {
    // 1,203 street names appear both bare and qualified, across 60% of parking
    // rows. Left alone they would rank as separate places.
    expect(splitLocation('BALLARDS LANE, N3')).toEqual({ street: 'BALLARDS LANE', postcodeDistrict: 'N3', locality: null });
    expect(splitLocation('HIGH ROAD, Whetstone')).toEqual({ street: 'HIGH ROAD', postcodeDistrict: null, locality: 'Whetstone' });
    expect(splitLocation('BALLARDS LANE')).toEqual({ street: 'BALLARDS LANE', postcodeDistrict: null, locality: null });
  });

  it('keeps a camera site whole, because its comma means something else', () => {
    /*
     * Three separate cameras sit on West Hendon Broadway. Splitting on the
     * comma merged all three into one location and credited one point with all
     * of their enforcement.
     */
    const a = splitLocation('A5 West Hendon Broadway (NW9), junction with Cool Oak Lane', false);
    const b = splitLocation('A5 West Hendon Broadway (NW9), junction with Station Road', false);
    expect(a.street).not.toBe(b.street);
    expect(a.postcodeDistrict).toBe('NW9');
  });

  it('refuses a row with no street', () => {
    const out = normaliseBarnetRow(raw('PARKING', { location: '   ' }), 3, 0);
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) expect(out.result.error.errorCode).toBe('MISSING_STREET');
  });
});

/* ---------------------------------------------------------------- */
/* Dates and derived time                                            */
/* ---------------------------------------------------------------- */

describe('dates and derived time', () => {
  it('refuses a missing or impossible date', () => {
    for (const date of ['', 'not a date', '2025-07-01', '31/02/2025', '32/01/2025']) {
      const out = normaliseBarnetRow(raw('PARKING', { date }), 4, 0);
      expect(out.result.ok, date).toBe(false);
      if (!out.result.ok) expect(out.result.error.errorCode).toBe('MISSING_OR_INVALID_DATE');
    }
  });

  it('reads dd/mm/yyyy as British, not American', () => {
    const out = normaliseBarnetRow(raw('PARKING', { date: '03/07/2025' }), 5, 0);
    expect(out.result.ok && out.result.event.issuedDate).toBe('2025-07-03');
  });

  it('derives hour and weekday rather than trusting the published columns', () => {
    // Barnet's Hour column disagrees with its issue time in 207 rows, always at
    // an exact hour boundary — 19:00:00 filed as hour 18.
    const out = normaliseBarnetRow(raw('MOVING_TRAFFIC', { date: '01/07/2025', time: '19:00:00' }), 6, 0);
    expect(out.result.ok && out.result.event.issuedHour).toBe(19);
    // 1 July 2025 was a Tuesday.
    expect(out.result.ok && out.result.event.issuedDayOfWeek).toBe(2);
  });
});

/* ---------------------------------------------------------------- */
/* Privacy                                                           */
/* ---------------------------------------------------------------- */

describe('privacy', () => {
  it('retains no source metadata at all', () => {
    expect(RETAINABLE_METADATA_FIELDS).toEqual([]);
  });

  it('emits only the fields the contract defines, and nothing from the row', () => {
    const out = normaliseBarnetRow(raw('PARKING'), 1, 0);
    expect(out.result.ok).toBe(true);
    if (!out.result.ok) return;
    const serialised = JSON.stringify(out.result.event);
    for (const forbidden of ['AB12CDE', 'Monday', 'Blank 2', 'Date picker']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('puts nothing from the row into an error excerpt', () => {
    const out = normaliseBarnetRow(raw('PARKING', { date: 'nonsense' }), 1, 0);
    expect(out.result.ok).toBe(false);
    if (!out.result.ok) {
      expect(out.result.error.rawExcerpt).toBeNull();
      expect(JSON.stringify(out.result.error)).not.toContain('BALLARDS LANE');
    }
  });
});

/* ---------------------------------------------------------------- */
/* Geography                                                         */
/* ---------------------------------------------------------------- */

describe('geography', () => {
  it('never invents a position, because Barnet publishes none', () => {
    for (const key of ['PARKING', 'BUS_LANE', 'MOVING_TRAFFIC'] as const) {
      const out = normaliseBarnetRow(raw(key), 1, 0);
      expect(out.result.ok).toBe(true);
      if (out.result.ok) {
        expect(out.result.event.longitude).toBeNull();
        expect(out.result.event.latitude).toBeNull();
      }
    }
  });

  it('declares no bounds, so nothing is measured against a rectangle nobody asserted', () => {
    expect(BARNET_SOURCE.bounds).toBeNull();
    // Camden does declare one — the two are not the same situation.
    expect(CAMDEN_SOURCE.bounds).toBeTruthy();
  });
});

/* ---------------------------------------------------------------- */
/* Registered, and still inactive                                    */
/* ---------------------------------------------------------------- */

describe('Barnet is ingestible and still invisible', () => {
  it('is registered as a source', () => {
    expect(knownSourceSlugs()).toContain('barnet-pcn');
    expect(requireSource('barnet-pcn').authoritySlug).toBe('barnet');
  });

  it('is not in the live list, so no public surface reads it', () => {
    /*
     * The separation this whole design rests on: being ingestible says nothing
     * about being shown.
     */
    expect(COVERAGE_SCOPE.liveAuthoritySlugs).toEqual(['camden']);
    expect(COVERAGE_SCOPE.liveAuthoritySlugs).not.toContain('barnet');
  });

  it('has no coverage area, so no search result claims it', () => {
    expect(authorityArea('barnet')).toBeNull();
    expect(isWithinCoverage(-0.199, 51.65)).toBe(false); // High Barnet
    expect(COVERED_AUTHORITY_NAME).toBe('Camden');
  });

  it('leaves the Camden source untouched', () => {
    expect(getSource('camden-pcn')?.authoritySlug).toBe('camden');
    expect(CAMDEN_SOURCE.slug).toBe('camden-pcn');
    expect(BARNET_SOURCE.slug).not.toBe(CAMDEN_SOURCE.slug);
  });

  it('never emits a Barnet event attributed to another authority', () => {
    for (const key of ['PARKING', 'BUS_LANE', 'MOVING_TRAFFIC'] as const) {
      const out = normaliseBarnetRow(raw(key), 1, 0);
      expect(out.result.ok && out.result.event.authoritySlug).toBe('barnet');
    }
  });

  it('carries the Open Government Licence and its attribution', () => {
    expect(BARNET_SOURCE.licence).toBe('Open Government Licence v3.0');
    expect(BARNET_SOURCE.publisher).toBe('London Borough of Barnet');
    expect(BARNET_SOURCE.attributionText).toContain('London Borough of Barnet');
    expect(BARNET_SOURCE.sourceUrl).toContain('open.barnet.gov.uk');
  });
});

describe('the adapter reads all three feeds as one source', () => {
  it('emits one stream across the feeds, classified per feed', async () => {
    const p = write('f-p.csv', [PARKING_HEADER, parkingRow('01/07/2025', '09:15:00', 'BALLARDS LANE, N3', '01 - Parked')]);
    const b = write('f-b.csv', [CAMERA_HEADER, cameraRow('02/07/2025', '10:00:00', 'A5 The Hyde (NW9)', '34J - Being in a bus lane')]);
    const m = write('f-m.csv', [CAMERA_HEADER, cameraRow('03/07/2025', '11:30:00', 'TILLING RD Junction Brentfield Gardens (NW2)', '31J - Box Junction (cam)')]);

    const adapter = createBarnetAdapter({ files: { PARKING: [p], BUS_LANE: [b], MOVING_TRAFFIC: [m] } });
    const fetched = await adapter.fetch({});
    expect(fetched.rows).toHaveLength(3);
    expect(fetched.sourceEffectiveDate).toBe('2025-07-03');

    const classes = fetched.rows.map((r, i) => {
      const res = adapter.normalise(r, i + 1);
      return res.ok ? res.event.enforcementType : 'REJECTED';
    });
    expect(new Set(classes)).toEqual(new Set(['PARKING', 'BUS_LANE', 'MOVING_TRAFFIC']));
  });

  it('applies the history window at the source', async () => {
    const p = write('w-p.csv', [
      PARKING_HEADER,
      parkingRow('01/01/2020', '09:15:00', 'OLD ROAD', '01 - Parked'),
      parkingRow('01/07/2025', '09:15:00', 'NEW ROAD', '01 - Parked'),
    ]);
    const b = write('w-b.csv', [CAMERA_HEADER]);
    const m = write('w-m.csv', [CAMERA_HEADER]);
    const adapter = createBarnetAdapter({ files: { PARKING: [p], BUS_LANE: [b], MOVING_TRAFFIC: [m] }, since: '2024-04-01' });
    const fetched = await adapter.fetch({});
    expect(fetched.rows).toHaveLength(1);
  });
});
