/**
 * Enforcement class.
 *
 * Camden's published dataset is not a parking dataset. The live sample contains
 * `ticket_type = MTC` — a moving traffic contravention, which is a different
 * enforcement regime from parking with different contraventions, a different
 * enforcement channel and a different meaning to a driver.
 *
 * The rule this file exists to enforce: **an unrecognised ticket type is never
 * assumed to be parking.** It becomes UNKNOWN and is counted separately, so a
 * new code appearing on the source shows up as an unclassified bucket in the
 * ingestion report rather than quietly inflating the parking figures.
 *
 * "PCN" is the correct umbrella term for all of these — a penalty charge notice
 * is issued for parking, bus lane and moving traffic contraventions alike — so
 * the product may say "PCNs" across the mix. It may not say "parking tickets".
 */

export type EnforcementClass = 'PARKING' | 'BUS_LANE' | 'MOVING_TRAFFIC' | 'UNKNOWN';

export interface EnforcementClassification {
  readonly enforcementClass: EnforcementClass;
  /** The raw source value, preserved so an UNKNOWN can be investigated. */
  readonly rawTicketType: string | null;
  /** True when the notice was issued from camera evidence rather than on street. */
  readonly viaCctv: boolean | null;
  /** Whether the class was recognised or defaulted. */
  readonly recognised: boolean;
}

/**
 * Exact ticket-type codes, matched case-insensitively on the trimmed value.
 *
 * Exact matching rather than substring matching: "MTC" must not be classified by
 * whether some longer string happens to contain "parking". Anything not listed
 * falls through to a conservative substring pass and then to UNKNOWN.
 */
const EXACT_TICKET_TYPES: Readonly<Record<string, EnforcementClass>> = {
  // Moving traffic contravention — the class the live sample revealed.
  MTC: 'MOVING_TRAFFIC',
  MT: 'MOVING_TRAFFIC',
  MOVING: 'MOVING_TRAFFIC',

  BL: 'BUS_LANE',
  BUS: 'BUS_LANE',
  BUSLANE: 'BUS_LANE',

  PCN: 'PARKING',
  PKG: 'PARKING',
  PARKING: 'PARKING',
  // On-street and off-street parking enforcement.
  ONSTREET: 'PARKING',
  OFFSTREET: 'PARKING',
};

/**
 * Substring fallbacks, applied only when the value is not an exact code.
 * Ordered most-specific first: "bus lane" before "lane", "moving traffic"
 * before "traffic", so a bus lane notice is never filed as moving traffic.
 */
const SUBSTRING_RULES: readonly { pattern: string; result: EnforcementClass }[] = [
  { pattern: 'bus lane', result: 'BUS_LANE' },
  { pattern: 'bus_lane', result: 'BUS_LANE' },
  { pattern: 'moving traffic', result: 'MOVING_TRAFFIC' },
  { pattern: 'moving_traffic', result: 'MOVING_TRAFFIC' },
  { pattern: 'parking', result: 'PARKING' },
];

export function classifyEnforcement(
  rawTicketType: unknown,
  rawDescription?: unknown,
  rawCctvFlag?: unknown,
): EnforcementClassification {
  const viaCctv = parseBoolean(rawCctvFlag);

  if (typeof rawTicketType !== 'string' || rawTicketType.trim() === '') {
    return { enforcementClass: 'UNKNOWN', rawTicketType: null, viaCctv, recognised: false };
  }

  const raw = rawTicketType.trim();
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');

  const exact = EXACT_TICKET_TYPES[key];
  if (exact) {
    return { enforcementClass: exact, rawTicketType: raw, viaCctv, recognised: true };
  }

  // The description may disambiguate where the code alone does not.
  const haystack = `${raw} ${typeof rawDescription === 'string' ? rawDescription : ''}`.toLowerCase();
  for (const rule of SUBSTRING_RULES) {
    if (haystack.includes(rule.pattern)) {
      return { enforcementClass: rule.result, rawTicketType: raw, viaCctv, recognised: true };
    }
  }

  // Unrecognised. Never guessed at, never defaulted to parking.
  return { enforcementClass: 'UNKNOWN', rawTicketType: raw, viaCctv, recognised: false };
}

function parseBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const v = value.trim().toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(v)) return true;
  if (['false', 'no', 'n', '0'].includes(v)) return false;
  return null;
}

/** Human label for a class, for use anywhere a figure is described. */
export const ENFORCEMENT_CLASS_LABELS: Readonly<Record<EnforcementClass, string>> = {
  PARKING: 'Parking',
  BUS_LANE: 'Bus lane',
  MOVING_TRAFFIC: 'Moving traffic',
  UNKNOWN: 'Unclassified',
};

/**
 * How a mixed set of enforcement classes should be described to a user.
 *
 * Returns wording that is true of whatever the set actually contains, so a page
 * showing moving-traffic notices can never be captioned "parking tickets".
 */
export function describeEnforcementMix(counts: Readonly<Partial<Record<EnforcementClass, number>>>): string {
  const present = (Object.entries(counts) as [EnforcementClass, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  if (present.length === 0) return 'No penalty charge notices recorded.';
  if (present.length === 1) {
    const [only] = present;
    switch (only![0]) {
      case 'PARKING':
        return 'Parking penalty charge notices.';
      case 'BUS_LANE':
        return 'Bus lane penalty charge notices.';
      case 'MOVING_TRAFFIC':
        return 'Moving traffic penalty charge notices — not parking.';
      default:
        return 'Penalty charge notices whose enforcement type the source did not classify.';
    }
  }

  const named = present.map(([c]) => ENFORCEMENT_CLASS_LABELS[c].toLowerCase());
  return `A mix of ${named.slice(0, -1).join(', ')} and ${named[named.length - 1]} penalty charge notices.`;
}
