import { createHash } from 'node:crypto';

/** Field-level normalisation shared by every source adapter. */

const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Street name normalisation for matching and deduplication.
 *
 * Deliberately conservative: it lowercases, collapses whitespace, strips
 * punctuation and expands the common abbreviations that appear in council
 * datasets. It does NOT try to correct spelling or guess at partial names —
 * two genuinely different streets must never collapse into one.
 */
const STREET_SUFFIXES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bst\b\.?/g, 'street'],
  [/\brd\b\.?/g, 'road'],
  [/\bave?\b\.?/g, 'avenue'],
  [/\bcres\b\.?/g, 'crescent'],
  [/\bgdns?\b\.?/g, 'gardens'],
  [/\bpl\b\.?/g, 'place'],
  [/\bsq\b\.?/g, 'square'],
  [/\bterr?\b\.?/g, 'terrace'],
  [/\bln\b\.?/g, 'lane'],
  [/\bmws\b\.?/g, 'mews'],
  [/\bpk\b\.?/g, 'park'],
  [/\bgrv\b\.?/g, 'grove'],
  [/\bct\b\.?/g, 'court'],
  [/\bcl\b\.?/g, 'close'],
];

export function normaliseStreetName(raw: string): string {
  let value = raw
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [pattern, replacement] of STREET_SUFFIXES) {
    value = value.replace(pattern, replacement);
  }

  return value.replace(/\s+/g, ' ').trim();
}

/** URL-safe slug derived from a street name. */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
}

/**
 * Parses a contravention code from a source field.
 *
 * Returns the canonical two-digit code plus any letter suffix. Anything that is
 * not recognisably a code returns null — a malformed code must not be coerced
 * into a valid-looking one.
 */
export function parseContraventionCode(
  raw: unknown,
): { code: string; suffix: string | null } | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  const match = /^0*(\d{1,2})\s*([a-zA-Z])?$/.exec(text);
  if (!match) return null;
  const digits = Number(match[1]);
  if (!Number.isInteger(digits) || digits < 0 || digits > 99) return null;
  return {
    code: String(digits).padStart(2, '0'),
    suffix: match[2] ? (match[2] as string).toLowerCase() : null,
  };
}

export interface ParsedTimestamp {
  /** ISO date, UTC. */
  readonly date: string;
  /** Full ISO timestamp, or null when the source supplied only a date. */
  readonly timestamp: string | null;
  readonly hour: number | null;
  readonly dayOfWeek: number | null;
}

/**
 * Parses a source timestamp.
 *
 * Council datasets mix ISO timestamps, date-only values and UK-style
 * DD/MM/YYYY. Ambiguous US-style dates are the classic silent corruption here, so
 * a slash-separated date is always read as day-first, and a value that could not
 * be a real calendar date is rejected rather than rolled over into the next month.
 */
export function parseSourceTimestamp(raw: unknown): ParsedTimestamp | null {
  if (raw instanceof Date) {
    return Number.isNaN(raw.getTime()) ? null : fromDate(raw, true);
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  // ISO 8601, with or without a time component.
  const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (iso) return build(iso[1], iso[2], iso[3], iso[4], iso[5], iso[6]);

  // UK day-first formats: DD/MM/YYYY or DD-MM-YYYY, optionally with a time.
  const uk = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (uk) return build(uk[3], uk[2], uk[1], uk[4], uk[5], uk[6]);

  return null;
}

function build(
  rawYear?: string,
  rawMonth?: string,
  rawDay?: string,
  rawHour?: string,
  rawMinute?: string,
  rawSecond?: string,
): ParsedTimestamp | null {
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const hasTime = rawHour !== undefined;
  const hour = hasTime ? Number(rawHour) : 0;
  const minute = hasTime ? Number(rawMinute) : 0;
  const second = hasTime && rawSecond !== undefined ? Number(rawSecond) : 0;

  if (hasTime && (hour > 23 || minute > 59 || second > 59)) return null;

  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (Number.isNaN(date.getTime())) return null;
  // Rejects 31 February and friends, which Date would otherwise roll forward.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return fromDate(date, hasTime);
}

function fromDate(date: Date, hasTime: boolean): ParsedTimestamp {
  return {
    date: date.toISOString().slice(0, 10),
    timestamp: hasTime ? date.toISOString() : null,
    hour: hasTime ? date.getUTCHours() : null,
    dayOfWeek: date.getUTCDay(),
  };
}

/** Separate time-only field, e.g. "14:35" or "1435". */
export function parseSourceTime(raw: unknown): { hour: number; minute: number } | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const text = String(raw).trim();
  const colon = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  const compact = /^(\d{2})(\d{2})$/.exec(text);
  const match = colon ?? compact;
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute };
}

export interface BoundingBox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

/**
 * Validates coordinates and confirms they fall inside a bounding box.
 *
 * A coordinate outside the expected area is far more likely to be a swapped
 * lat/long, a null island or a projection mix-up than a genuine PCN, so it is
 * rejected rather than plotted somewhere misleading.
 */
export function parseCoordinates(
  rawLon: unknown,
  rawLat: unknown,
  bbox: BoundingBox,
): { longitude: number; latitude: number } | null {
  const longitude = toFiniteNumber(rawLon);
  const latitude = toFiniteNumber(rawLat);
  if (longitude === null || latitude === null) return null;
  if (longitude === 0 && latitude === 0) return null;
  if (longitude < bbox.minLon || longitude > bbox.maxLon) return null;
  if (latitude < bbox.minLat || latitude > bbox.maxLat) return null;
  return { longitude, latitude };
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

/** UK postcode district, e.g. "NW1" from "NW1 2AB". Null when not derivable. */
export function parsePostcodeDistrict(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const full = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*\d[A-Z]{2}\b/i.exec(trimmed);
  if (full) return (full[1] as string).toUpperCase();
  const districtOnly = /^([A-Z]{1,2}\d[A-Z\d]?)$/i.exec(trimmed);
  return districtOnly ? (districtOnly[1] as string).toUpperCase() : null;
}

/**
 * Reads a postcode district off the end of a location string.
 *
 * Camden publishes the district inside the street value ("MAPLE STREET W1")
 * rather than in a column of its own, so without this the field stays null while
 * the data plainly contains it. The district is the single most useful
 * disambiguator for a street-reference lookup — two boroughs' worth of "Church
 * Street" resolve differently once you know the district.
 *
 * Only a trailing district is taken. A district in the middle of a string is not
 * matched, because that is more likely to be part of a name than a locator.
 */
export function parseTrailingPostcodeDistrict(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const match = /\s([A-Z]{1,2}\d[A-Z\d]?)$/i.exec(raw.trim());
  return match ? (match[1] as string).toUpperCase() : null;
}

/** Stable hash of the normalised row, used to detect genuine upstream changes. */
export function rowHash(parts: readonly (string | number | null)[]): string {
  return createHash('sha256').update(parts.map((p) => String(p ?? '')).join(' ')).digest('hex');
}

/**
 * Content hash of a fetched payload, used to tell a genuine upstream change from
 * a re-fetch of the same data.
 *
 * Hashed row by row rather than by stringifying the whole payload at once.
 * `JSON.stringify` on a large array throws `RangeError: Invalid string length`
 * once the result exceeds V8's maximum string size — which a full borough
 * dataset reaches — and it did, on the first end-to-end run at realistic volume.
 * Feeding the hash incrementally has no such ceiling and allocates one row at a
 * time instead of the entire payload.
 */
export function contentHash(payload: unknown): string {
  const hash = createHash('sha256');
  if (Array.isArray(payload)) {
    hash.update(`[${payload.length}]`);
    for (const item of payload) hash.update(JSON.stringify(item) ?? 'undefined');
  } else {
    hash.update(JSON.stringify(payload) ?? 'undefined');
  }
  return hash.digest('hex');
}
