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
  /** Which signal decided the class, so a classification can be audited. */
  readonly basis: ClassificationBasis;
}

/**
 * Where a classification came from, in the order the evidence is trusted.
 *
 * `TICKET_TYPE` is a code the source uses deliberately. `TICKET_DESCRIPTION` is
 * the source's label for that code. `CONTRAVENTION_DESCRIPTION` is the source's
 * own words for what the driver actually did, which is the most specific
 * evidence available and the only thing that resolves a ticket type whose
 * meaning the source does not spell out.
 */
export type ClassificationBasis =
  | 'TICKET_TYPE'
  | 'TICKET_DESCRIPTION'
  | 'CONTRAVENTION_DESCRIPTION'
  | 'NONE';

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

/**
 * Phrases from the authority's own contravention description.
 *
 * The live sample forced this: `ticket_type = "O/S TMA"` with
 * `ticket_description = "On Street Contravention"` says *where* the contravention
 * happened, not *what* it was. Reading "on street" as "parking" would be my
 * inference, not Camden's statement. The contravention description is Camden's
 * own words for what the driver actually did, so it is what decides.
 *
 * Ordered most-specific first, and only phrases that mean one thing are listed:
 * a description that matches nothing here stays UNKNOWN rather than being
 * pushed into the nearest class.
 */
const CONTRAVENTION_PHRASES: readonly { pattern: string; result: EnforcementClass }[] = [
  { pattern: 'bus lane', result: 'BUS_LANE' },
  { pattern: 'bus gate', result: 'BUS_LANE' },

  { pattern: 'moving traffic', result: 'MOVING_TRAFFIC' },
  { pattern: 'one-way', result: 'MOVING_TRAFFIC' },
  { pattern: 'one way', result: 'MOVING_TRAFFIC' },
  { pattern: 'prohibited turn', result: 'MOVING_TRAFFIC' },
  { pattern: 'banned turn', result: 'MOVING_TRAFFIC' },
  { pattern: 'no entry', result: 'MOVING_TRAFFIC' },
  { pattern: 'box junction', result: 'MOVING_TRAFFIC' },
  { pattern: 'yellow box', result: 'MOVING_TRAFFIC' },
  { pattern: 'motor vehicles prohibited', result: 'MOVING_TRAFFIC' },

  { pattern: 'parked', result: 'PARKING' },
  { pattern: 'parking', result: 'PARKING' },
  { pattern: 'waiting restriction', result: 'PARKING' },
  { pattern: 'loading', result: 'PARKING' },
  { pattern: 'pay and display', result: 'PARKING' },
  { pattern: 'permit', result: 'PARKING' },
  { pattern: 'meter', result: 'PARKING' },
  { pattern: 'bay', result: 'PARKING' },
];

export function classifyEnforcement(
  rawTicketType: unknown,
  rawDescription?: unknown,
  rawCctvFlag?: unknown,
  rawContraventionDescription?: unknown,
): EnforcementClassification {
  const viaCctv = parseBoolean(rawCctvFlag);
  const contraventionText =
    typeof rawContraventionDescription === 'string' ? rawContraventionDescription.toLowerCase() : '';

  const fromContravention = (raw: string | null): EnforcementClassification => {
    for (const rule of CONTRAVENTION_PHRASES) {
      if (contraventionText.includes(rule.pattern)) {
        return {
          enforcementClass: rule.result,
          rawTicketType: raw,
          viaCctv,
          recognised: true,
          basis: 'CONTRAVENTION_DESCRIPTION',
        };
      }
    }
    // Unrecognised. Never guessed at, never defaulted to parking.
    return { enforcementClass: 'UNKNOWN', rawTicketType: raw, viaCctv, recognised: false, basis: 'NONE' };
  };

  if (typeof rawTicketType !== 'string' || rawTicketType.trim() === '') {
    return fromContravention(null);
  }

  const raw = rawTicketType.trim();
  const key = raw.toUpperCase().replace(/[^A-Z]/g, '');

  const exact = EXACT_TICKET_TYPES[key];
  if (exact) {
    return { enforcementClass: exact, rawTicketType: raw, viaCctv, recognised: true, basis: 'TICKET_TYPE' };
  }

  // The ticket description may disambiguate where the code alone does not.
  const haystack = `${raw} ${typeof rawDescription === 'string' ? rawDescription : ''}`.toLowerCase();
  for (const rule of SUBSTRING_RULES) {
    if (haystack.includes(rule.pattern)) {
      return {
        enforcementClass: rule.result,
        rawTicketType: raw,
        viaCctv,
        recognised: true,
        basis: 'TICKET_DESCRIPTION',
      };
    }
  }

  // Last resort: what the authority says the driver actually did.
  return fromContravention(raw);
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
