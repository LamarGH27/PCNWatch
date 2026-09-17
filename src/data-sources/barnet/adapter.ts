import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { normaliseStreetName, slugify } from '../shared/normalise';
import type {
  FetchResult,
  IngestionAdapter,
  NormalisationResult,
  SourceDescriptor,
} from '../shared/types';
import { noGeometry } from '@/core/geography/types';
import { BARNET_FEEDS, type BarnetFeed, type BarnetFeedKey } from './feeds';
import {
  BARNET_COLUMN_COUNT,
  fingerprintColumns,
  isWarningNotice,
  parseBarnetContravention,
  splitLocation,
} from './schema';

export const BARNET_AUTHORITY_SLUG = 'barnet';

export const BARNET_SOURCE: SourceDescriptor = {
  slug: 'barnet-pcn',
  name: 'Barnet penalty charge notices',
  publisher: 'London Borough of Barnet',
  licence: 'Open Government Licence v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  sourceUrl: 'https://open.barnet.gov.uk/',
  attributionText:
    'Contains public sector information from the London Borough of Barnet licensed under the Open Government Licence v3.0.',
  coverageNotes:
    'Penalty charge notices issued in the London Borough of Barnet across parking, bus lane and moving traffic enforcement. Barnet publishes no coordinates, so activity is ranked by street and not placed on a map. Bus lane warning notices are excluded from penalty charge figures.',
  /*
   * No declared extent, deliberately.
   *
   * The bounds exist so the quality gate can catch a coordinate that cannot
   * plausibly be in the borough. Barnet publishes no coordinates at all, in any
   * of its three datasets, so there is nothing to check and a rectangle here
   * would assert an expectation about data that does not exist. The gate skips
   * the check rather than measuring zero coordinates against a box.
   */
  bounds: null,
};

export class BarnetFetchError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_CONFIGURED' | 'UNREADABLE' | 'MALFORMED_PAYLOAD' | 'HEADER_MISMATCH',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'BarnetFetchError';
  }
}

/**
 * Decodes a Barnet CSV.
 *
 * Barnet does not ship one encoding. Parking is UTF-8 with a byte-order mark,
 * Moving Traffic is plain UTF-8, and the Bus Lane file is Windows-1252 with
 * CRLF line endings — 890 of its bytes are 0x96, an en dash, which makes
 * reading it as UTF-8 throw outright rather than merely look wrong.
 *
 * Strictest first, because cp1252 cannot fail: every byte sequence decodes to
 * something under it. Trying it first would silently turn a genuine UTF-8 file
 * into mojibake that no later stage could detect.
 */
export function decodeCsv(bytes: Buffer): { text: string; encoding: 'utf-8' | 'cp1252' } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'utf-8' };
  } catch {
    const text = new TextDecoder('windows-1252').decode(bytes);
    return { text: text.replace(/^﻿/, ''), encoding: 'cp1252' };
  }
}

/** Minimal RFC4180 reader. Barnet quotes nothing, but a quoted comma must not split a row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
      continue;
    }
    field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface BarnetRawRow {
  readonly feed: BarnetFeed;
  readonly date: string;
  readonly time: string;
  readonly location: string;
  readonly contravention: string;
}

/**
 * Reads one feed's partitions into rows.
 *
 * Every partition repeats the header. It is compared rather than skipped: a
 * mismatched header means the parts are not what they claim to be, and
 * continuing would interleave two column orders into one stream.
 */
export function readFeed(feed: BarnetFeed, paths: readonly string[]): BarnetRawRow[] {
  if (paths.length === 0) {
    throw new BarnetFetchError(
      `No files configured for the Barnet ${feed.key} feed (${feed.pathEnvVar}).`,
      'NOT_CONFIGURED',
    );
  }

  const out: BarnetRawRow[] = [];
  let header: string[] | null = null;

  for (const path of paths) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      throw new BarnetFetchError(`Could not read ${path}.`, 'UNREADABLE', error);
    }

    const rows = parseCsv(decodeCsv(bytes).text);
    if (rows.length === 0) throw new BarnetFetchError(`${path} is empty.`, 'MALFORMED_PAYLOAD');

    const head = (rows[0] as string[]).map((c) => c.trim());
    if (header === null) {
      if (head.length !== BARNET_COLUMN_COUNT) {
        throw new BarnetFetchError(
          `${path} has ${head.length} columns, expected ${BARNET_COLUMN_COUNT}.`,
          'MALFORMED_PAYLOAD',
        );
      }
      header = head;
    } else if (JSON.stringify(head) !== JSON.stringify(header)) {
      throw new BarnetFetchError(
        `${path} has a different header from the first partition of this feed.`,
        'HEADER_MISMATCH',
      );
    }

    const di = header.indexOf(feed.dateColumn);
    const ti = header.indexOf(feed.timeColumn);
    const li = header.indexOf(feed.locationColumn);
    const ci = header.indexOf('Contravention');
    if (di < 0 || ti < 0 || li < 0 || ci < 0) {
      throw new BarnetFetchError(
        `${path} is missing one of ${feed.dateColumn}, ${feed.timeColumn}, ${feed.locationColumn}, Contravention.`,
        'MALFORMED_PAYLOAD',
      );
    }

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r] as string[];
      out.push({
        feed,
        date: (row[di] ?? '').trim(),
        time: (row[ti] ?? '').trim(),
        location: (row[li] ?? '').trim(),
        contravention: (row[ci] ?? '').trim(),
      });
    }
  }

  return out;
}

/** Header fingerprint for a feed, recorded so a shape change is visible after the fact. */
export function feedFingerprint(paths: readonly string[]): string | null {
  const first = paths[0];
  if (!first) return null;
  const rows = parseCsv(decodeCsv(readFileSync(first)).text.slice(0, 4096));
  return rows[0] ? fingerprintColumns((rows[0] as string[]).map((c) => c.trim())) : null;
}

/**
 * Barnet publishes no record identifier, so one has to be constructed.
 *
 * The obvious construction is wrong. Hashing date, time, street and
 * contravention alone collapses 49,217 rows across the three feeds — 4.1% of
 * moving traffic, 4.6% of bus lane — because Barnet records time to the minute
 * and several vehicles genuinely are caught at one box junction inside one
 * minute. Those are distinct penalty charge notices, and they cluster at the
 * busiest locations, so discarding them would quietly flatten exactly the
 * hotspots this product exists to find.
 *
 * So the ordinal of a row within its identical-tuple group is part of the
 * identity. Two notices agreeing on every published field become the first and
 * second such notice, which is the most the source lets anyone say about them,
 * and both survive.
 *
 * What this buys, and what it does not:
 *
 *   * Deterministic — the same file always produces the same ids.
 *   * Stable under append, which is how Barnet refreshes: rows for a past
 *     minute do not change, so neither do their ordinals.
 *   * Not stable if Barnet restates history and changes how many notices one
 *     minute contains. Then ordinals inside that single group shift. Those rows
 *     are indistinguishable from one another, so no location, day or count
 *     changes — only which indistinguishable row holds which id.
 *
 * Deliberately built from nothing identifying. There is no PCN number and no
 * registration in the source, and this must not become a reason to want one.
 */
export function barnetRecordId(row: BarnetRawRow, ordinal: number): string {
  const key = [
    'barnet',
    row.feed.key,
    row.date,
    row.time,
    row.location.toUpperCase(),
    row.contravention.toUpperCase(),
    String(ordinal),
  ].join('|');
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Assigns each row its ordinal within its identical-tuple group, in file order. */
export function assignOrdinals(rows: readonly BarnetRawRow[]): number[] {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = [
      row.feed.key,
      row.date,
      row.time,
      row.location.toUpperCase(),
      row.contravention.toUpperCase(),
    ].join('|');
    const next = seen.get(key) ?? 0;
    seen.set(key, next + 1);
    return next;
  });
}

const DATE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const TIME = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

export interface BarnetNormaliseOutcome {
  readonly result: NormalisationResult;
  /** True when the row is a warning notice and was deliberately not emitted. */
  readonly warningNotice: boolean;
}

function reject(rowNumber: number, code: string, message: string): NormalisationResult {
  return {
    ok: false,
    error: {
      sourceRecordId: null,
      rowNumber,
      errorCode: code,
      errorMessage: message,
      rawExcerpt: null,
    },
  };
}

export function normaliseBarnetRow(
  row: BarnetRawRow,
  rowNumber: number,
  ordinal: number,
): BarnetNormaliseOutcome {
  const contravention = parseBarnetContravention(row.contravention);

  /*
   * Warning notices leave before anything else happens to them.
   *
   * Nothing is wrong with the row, so it is reported under its own code rather
   * than counted as a parse failure — and it never reaches the aggregate a
   * Ticket Activity Score is computed from. A warning notice charged nobody
   * anything, and letting one inflate a location's enforcement figure would
   * make the score describe something other than enforcement.
   */
  if (isWarningNotice(contravention)) {
    return {
      result: reject(rowNumber, 'WARNING_NOTICE', 'Warning notice, not a penalty charge.'),
      warningNotice: true,
    };
  }

  const dm = DATE.exec(row.date);
  if (!dm) {
    return {
      result: reject(rowNumber, 'MISSING_OR_INVALID_DATE', 'Issue date is missing or not dd/mm/yyyy.'),
      warningNotice: false,
    };
  }
  const [, dd, mm, yyyy] = dm;
  const issuedDate = `${yyyy}-${mm}-${dd}`;
  const parsed = new Date(`${issuedDate}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getUTCDate() !== Number(dd) ||
    parsed.getUTCMonth() + 1 !== Number(mm)
  ) {
    return {
      result: reject(rowNumber, 'MISSING_OR_INVALID_DATE', 'Issue date is not a real calendar date.'),
      warningNotice: false,
    };
  }

  const split = splitLocation(row.location, row.feed.splitsLocationQualifier);
  if (split.street === '') {
    return {
      result: reject(rowNumber, 'MISSING_STREET', 'No street or location on the row.'),
      warningNotice: false,
    };
  }

  /*
   * Hour and day of week are derived, never read.
   *
   * Barnet ships both as columns, and its `Hour` disagrees with the issue time
   * in 207 rows, always at an exact hour boundary — its own derivation rounding
   * a timestamp the file no longer contains. Deriving them keeps the temporal
   * profile consistent with the timestamp it describes.
   */
  const tm = TIME.exec(row.time);
  const issuedAt = tm ? `${issuedDate}T${String(tm[1]).padStart(2, '0')}:${tm[2]}:00Z` : null;
  const issuedHour = tm ? Number(tm[1]) : null;

  const streetNameNormalised = normaliseStreetName(split.street);
  const recordId = barnetRecordId(row, ordinal);

  return {
    warningNotice: false,
    result: {
      ok: true,
      warnings: contravention.full === null ? ['Contravention code could not be read.'] : [],
      event: {
        sourceRecordId: recordId,
        authoritySlug: BARNET_AUTHORITY_SLUG,
        contraventionCode: contravention.code,
        enforcementType: row.feed.enforcementClass,
        issuedDate,
        issuedAt,
        issuedHour,
        issuedDayOfWeek: parsed.getUTCDay(),
        streetName: split.street,
        streetNameNormalised,
        locationSlug: slugify(streetNameNormalised),
        locality: split.locality,
        postcodeDistrict: split.postcodeDistrict,
        /*
         * Barnet publishes no coordinates in any of its three datasets, and no
         * licensed reproducible reference is loaded that could supply one. So
         * there is no position, and saying so is the point: a street centroid
         * or a camera location standing in for the notice would be a number
         * nobody published.
         */
        longitude: null,
        latitude: null,
        dataConfidence: 0.8,
        sourceMetadata: noGeometry('NO_STREET_REFERENCE_CONFIGURED') as unknown as Record<
          string,
          unknown
        >,
        rowHash: recordId,
      },
    },
  };
}

export interface BarnetAdapterOptions {
  /** Feed key to the partition paths for that feed, in order. */
  readonly files: Partial<Record<BarnetFeedKey, readonly string[]>>;
  /** Ignore rows issued before this ISO date. The history window. */
  readonly since?: string;
}

export function barnetFilesFromEnv(): BarnetAdapterOptions['files'] {
  const files: Record<string, readonly string[]> = {};
  for (const feed of BARNET_FEEDS) {
    const raw = process.env[feed.pathEnvVar]?.trim();
    if (raw) files[feed.key] = raw.split(',').map((p) => p.trim()).filter(Boolean);
  }
  return files;
}

export function createBarnetAdapter(options: BarnetAdapterOptions): IngestionAdapter {
  return {
    descriptor: BARNET_SOURCE,

    async fetch({ since, limit } = {}): Promise<FetchResult> {
      const cutoff = since ?? options.since;
      const all: BarnetRawRow[] = [];
      const fingerprints: string[] = [];

      for (const feed of BARNET_FEEDS) {
        const paths = options.files[feed.key] ?? [];
        // Appended one at a time rather than spread. `push(...rows)` passes
        // every row as a separate argument, and a Barnet feed is hundreds of
        // thousands of rows — enough to exhaust the call stack before any of
        // this code gets to be wrong about anything else.
        for (const row of readFeed(feed, paths)) all.push(row);
        const fp = feedFingerprint(paths);
        if (fp) fingerprints.push(`${feed.key}:${fp}`);
      }

      const windowed = cutoff
        ? all.filter((row) => {
            const m = DATE.exec(row.date);
            return m ? `${m[3]}-${m[2]}-${m[1]}` >= cutoff : true;
          })
        : all;

      const rows = limit ? windowed.slice(0, limit) : windowed;
      const ordinals = assignOrdinals(rows);
      const carried = rows.map((row, i) => ({ ...row, __ordinal: ordinals[i] as number }));

      const digest = createHash('sha256');
      const isoDates: string[] = [];
      for (const row of rows) {
        digest.update(`${row.feed.key}|${row.date}|${row.time}|${row.location}|${row.contravention}\n`);
        const m = DATE.exec(row.date);
        if (m) isoDates.push(`${m[3]}-${m[2]}-${m[1]}`);
      }
      isoDates.sort();
      const lastIso = isoDates[isoDates.length - 1] ?? null;

      return {
        rows: carried,
        versionLabel: lastIso ? `barnet-${lastIso}` : 'barnet-snapshot',
        contentHash: digest.digest('hex'),
        retrievedAt: new Date().toISOString(),
        sourceEffectiveDate: lastIso,
        schemaFingerprint: fingerprints.join(','),
      };
    },

    normalise(row: unknown, rowNumber: number): NormalisationResult {
      const r = row as BarnetRawRow & { __ordinal?: number };
      if (!r || typeof r !== 'object' || !r.feed) {
        return reject(rowNumber, 'MALFORMED_ROW', 'Row did not come from the Barnet reader.');
      }
      return normaliseBarnetRow(r, rowNumber, r.__ordinal ?? 0).result;
    },
  };
}
