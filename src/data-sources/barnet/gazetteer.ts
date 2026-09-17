import { readFileSync } from 'node:fs';
import { bngToWgs84 } from '@/core/geography/osgb';
import { joinKey, type GazetteerEntry } from './street-match';

/**
 * OS Open Names, read as the official product actually ships.
 *
 * Two properties of the format decide how this is written. The CSVs carry **no
 * header row** — the column order is the schema, published separately — so the
 * positions below are the contract and are asserted against the official header
 * file in the tests rather than trusted. And the geometry is British National
 * Grid, not longitude and latitude, so every point is transformed; treating an
 * easting as a longitude would put Barnet in the Atlantic.
 *
 * Nothing here is bundled with the repository. The tiles are an Ordnance Survey
 * download under the Open Government Licence and are supplied at run time, the
 * same way Barnet's own CSVs are.
 */

/** Column positions, from OS_Open_Names_Header.csv. */
export const OS_COLUMN = {
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
} as const;

export const OS_COLUMN_COUNT = 34;

/**
 * The local types that are a road.
 *
 * `Named Road` is one record for a whole road; `Section Of Named Road` is a
 * piece of one and carries no persistent identifier. Numbered roads are
 * deliberately excluded: their `NAME1` is the number ("A41"), which is not what
 * Barnet's parking data calls a street, so they can only add candidates that
 * cannot legitimately match.
 */
export const ROAD_LOCAL_TYPES: Readonly<Record<string, GazetteerEntry['kind']>> = {
  'Named Road': 'NAMED_ROAD',
  'Section Of Named Road': 'ROAD_SECTION',
};

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { out.push(field); field = ''; continue; }
    field += ch;
  }
  out.push(field);
  return out;
}

export interface LoadOptions {
  /** Keep only roads in this district, as OS spells it. */
  readonly district: string;
}

export interface LoadResult {
  readonly entries: readonly GazetteerEntry[];
  readonly rowsRead: number;
  readonly roadsInDistrict: number;
  readonly malformed: number;
}

/** Reads one or more OS Open Names tiles into road entries for one district. */
export function loadOsOpenNames(paths: readonly string[], options: LoadOptions): LoadResult {
  const entries: GazetteerEntry[] = [];
  let rowsRead = 0;
  let malformed = 0;

  for (const path of paths) {
    const text = readFileSync(path, 'utf8').replace(/^﻿/, '');
    for (const line of text.split(/\r?\n/)) {
      if (line === '') continue;
      rowsRead += 1;
      const row = parseCsvLine(line);
      if (row.length !== OS_COLUMN_COUNT) {
        malformed += 1;
        continue;
      }

      const kind = ROAD_LOCAL_TYPES[(row[OS_COLUMN.LOCAL_TYPE] ?? '').trim()];
      if (!kind) continue;
      if ((row[OS_COLUMN.DISTRICT_BOROUGH] ?? '').trim() !== options.district) continue;

      const easting = Number(row[OS_COLUMN.GEOMETRY_X]);
      const northing = Number(row[OS_COLUMN.GEOMETRY_Y]);
      if (!Number.isFinite(easting) || !Number.isFinite(northing)) {
        malformed += 1;
        continue;
      }

      const { longitude, latitude } = bngToWgs84(easting, northing);
      const postcode = (row[OS_COLUMN.POSTCODE_DISTRICT] ?? '').trim();
      const place = (row[OS_COLUMN.POPULATED_PLACE] ?? '').trim();

      entries.push({
        id: (row[OS_COLUMN.ID] ?? '').trim(),
        name: (row[OS_COLUMN.NAME1] ?? '').trim(),
        kind,
        district: (row[OS_COLUMN.DISTRICT_BOROUGH] ?? '').trim(),
        postcodeDistrict: postcode === '' ? null : postcode,
        populatedPlace: place === '' ? null : place,
        longitude,
        latitude,
      });
    }
  }

  return { entries, rowsRead, roadsInDistrict: entries.length, malformed };
}

/**
 * Groups entries by normalised name, which is the only key a match may use.
 *
 * Built once and shared: the matcher is handed the candidates for a name, so
 * the lookup itself can never widen a match — it can only find entries whose
 * normalised name is exactly equal.
 */
export function indexByName(
  entries: readonly GazetteerEntry[],
): ReadonlyMap<string, readonly GazetteerEntry[]> {
  const index = new Map<string, GazetteerEntry[]>();
  for (const entry of entries) {
    const key = joinKey(entry.name);
    const bucket = index.get(key);
    if (bucket) bucket.push(entry);
    else index.set(key, [entry]);
  }
  return index;
}
