import { createHash } from 'node:crypto';

/**
 * Barnet's published CSV shape, as the files actually are.
 *
 * Nine columns in both variants, of which four carry information:
 *
 *   Parking : Time, Date, "", Contravention, Street, Day, Hour, "Blank 2", "Date 2"
 *   BL / MTC: Issue time, Issue Date, Column1, Contravention, Location, Day, Hour, Column2, "Date picker"
 *
 * The other five are measured, not assumed: `Column1`/`Column2`/`Blank 2` and
 * the unnamed third column are empty in 100% of all 1,903,562 rows; `Date
 * picker`/`Date 2` equals the issue date in 100% of rows; `Day` equals the
 * weekday of the issue date in 100% of rows.
 *
 * `Hour` is the exception and the reason it is not trusted: it disagrees with
 * the hour of `Issue time` in 207 rows, always at an exact hour boundary
 * (19:00:00 recorded as hour 18), which is Barnet's own derivation rounding a
 * timestamp the file no longer contains. Hour and day of week are therefore
 * derived here from the timestamp rather than read, so the temporal profile
 * behind a Ticket Activity Score cannot inherit that inconsistency.
 */

export const BARNET_COLUMN_COUNT = 9;

/** Columns whose value is discarded: empty in every row, or derivable exactly. */
export const DELIBERATELY_DROPPED_FIELDS: readonly string[] = [
  'Column1',
  'Column2',
  'Blank 2',
  '',
  'Date picker',
  'Date 2',
  'Day',
  'Hour',
];

/**
 * Nothing from a Barnet row may be retained as source metadata.
 *
 * Camden keeps a handful of fields for investigation. Barnet publishes four
 * useful columns and all four become first-class fields on the normalised
 * event, so there is nothing left that is worth keeping and nothing that could
 * be kept by accident.
 */
export const RETAINABLE_METADATA_FIELDS: readonly string[] = [];

/** London postcode districts, as they appear after the comma in a street value. */
const POSTCODE_DISTRICT = /^(?:N|NW|EN|HA|E|W|WC|EC|SE|SW)\d{1,2}[A-Z]?$/i;

export interface SplitLocation {
  readonly street: string;
  readonly postcodeDistrict: string | null;
  readonly locality: string | null;
}

/**
 * Splits "BALLARDS LANE, N3" into a street and its district.
 *
 * Barnet records the same street both bare and qualified — 1,203 street names
 * appear in both forms, across 60% of parking rows. Left alone, `BALLARDS LANE`,
 * `BALLARDS LANE, N3` and `BALLARDS LANE, N12` would rank as three separate
 * places, splitting one street's enforcement three ways and putting three rows
 * in the comparison population where there is one street.
 *
 * So the qualifier moves to its own field and the street is what is ranked —
 * the same convention Camden already uses for "MAPLE STREET W1", which is why
 * this reads as a parsing difference rather than a different product rule.
 *
 * But only a *postcode district* qualifier works that way, and assuming a
 * locality did too was wrong. "BALLARDS LANE, N3" and "BALLARDS LANE, N12" are
 * one road crossing a district boundary. "HIGH ROAD, North Finchley",
 * "HIGH ROAD, Whetstone" and "HIGH ROAD, East Finchley" are three different
 * roads, carrying 15,144, 8,417 and 3,194 notices — and Ordnance Survey holds
 * them as separate records too. Merging those would not merely lose precision,
 * it would add three roads' enforcement together and rank the total as one
 * place.
 *
 * So the locality stays part of what makes this location distinct, and is
 * additionally reported on its own so a gazetteer match can use it. The
 * postcode district is stripped, as before.
 *
 * Safe because the shape is regular: no Barnet value contains more than one
 * comma, so there is exactly one place to split and no ambiguity about which
 * comma meant what.
 */
export function splitLocation(raw: string, splitQualifier = true): SplitLocation {
  const value = raw.trim();

  /*
   * A camera feed's whole value is the site's identity.
   *
   * Only the district in brackets is lifted out, and it is left in place as
   * well: "A5 West Hendon Broadway (NW9), junction with Cool Oak Lane" is one
   * camera and must not become "A5 West Hendon Broadway (NW9)", which is where
   * three of them meet.
   */
  if (!splitQualifier) {
    const bracketed = /\((N|NW|EN|HA|E|W|WC|EC|SE|SW)\d{1,2}[A-Z]?\)/i.exec(value);
    return {
      street: value,
      postcodeDistrict: bracketed ? bracketed[0].slice(1, -1).toUpperCase() : null,
      locality: null,
    };
  }

  const comma = value.lastIndexOf(',');
  if (comma === -1) return { street: value, postcodeDistrict: null, locality: null };

  const street = value.slice(0, comma).trim();
  const suffix = value.slice(comma + 1).trim();
  if (street === '' || suffix === '') {
    return { street: value, postcodeDistrict: null, locality: null };
  }

  return POSTCODE_DISTRICT.test(suffix)
    ? { street, postcodeDistrict: suffix.toUpperCase(), locality: null }
    : { street, postcodeDistrict: null, locality: suffix };
}

export interface ParsedContravention {
  /** The numeric code, e.g. "34". Null when the value does not start with one. */
  readonly code: string | null;
  /** The letter suffix, e.g. "J" or "W", uppercased. Null when absent. */
  readonly suffix: string | null;
  /** Code and suffix together, e.g. "34J". */
  readonly full: string | null;
}

/**
 * Reads "34J - Being in a bus lane" into its parts.
 *
 * Keyed on the code and never on the description, because the description is
 * not stable: contravention 40 appears as both "disabled person's" and
 * "disabled person?s" in the same file, the apostrophe having been mangled by
 * an encoding round-trip somewhere upstream. Two spellings, one contravention.
 *
 * The separator is optional: Barnet writes "51J Failing to comply…" without a
 * dash for two of its codes.
 */
export function parseBarnetContravention(raw: string): ParsedContravention {
  const match = /^\s*(\d{1,3})\s*([A-Za-z])?\s*(?:-|\s)/.exec(raw ?? '');
  if (!match) return { code: null, suffix: null, full: null };
  const code = match[1] as string;
  const suffix = match[2] ? match[2].toUpperCase() : null;
  return { code, suffix, full: suffix ? `${code}${suffix}` : code };
}

/**
 * Whether a contravention is a Warning Notice rather than a penalty charge.
 *
 * Barnet states that its bus lane dataset includes warning notices, which carry
 * no monetary value — and the raw CSV has no amount column, so they cannot be
 * told apart by what they cost. The `W` suffix is what distinguishes them, and
 * the data bears it out rather than merely permitting it:
 *
 *   * 34W appears 148 times, at exactly two locations, inside a 64-day window;
 *   * both of those cameras issue their first ordinary 34J on 2017-11-16,
 *     fifteen days after their first 34W on 2017-11-01;
 *   * no other Barnet code in any of the three feeds carries a W suffix.
 *
 * That is a camera bedding-in period, which is when warning notices are issued.
 * They are counted and reported, never mixed into PCN figures: a warning notice
 * is not a penalty charge and a location's enforcement activity must not be
 * inflated by notices that charged nobody anything.
 */
export function isWarningNotice(parsed: ParsedContravention): boolean {
  return parsed.suffix === 'W';
}

/** Stable 16-hex digest of a column set, so a shape change is visible later. */
export function fingerprintColumns(header: readonly string[]): string {
  return createHash('sha256').update([...header].sort().join(',')).digest('hex').slice(0, 16);
}
