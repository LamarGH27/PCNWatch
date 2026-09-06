import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';

/**
 * Who issued the notice, judged from the name printed on it.
 *
 * This exists because *who issued a notice* and *whether PCNWatch holds data
 * about that place* are different questions, and conflating them told a
 * Westminster driver their real council PCN was an unidentifiable document.
 * Camden is the only borough with enforcement history; every English council
 * issues penalty charge notices under the same statute.
 *
 * So this answers only the first question. Coverage is decided separately, and
 * a recognised authority we hold nothing else about still gets an assessment.
 */

export type AuthorityKind = 'LOCAL_AUTHORITY' | 'PRIVATE_OPERATOR' | 'UNRECOGNISED';

export interface AuthorityClassification {
  readonly kind: AuthorityKind;
  /** Set when the name matched an authority PCNWatch lists. */
  readonly authoritySlug: string | null;
  /** What in the name decided it, so a wrong answer can be traced. */
  readonly matchedOn: string | null;
}

/**
 * Shapes that only a public body uses.
 *
 * Deliberately structural rather than a list of names: there are around 300
 * English billing authorities plus Wales and Scotland, and a list would be
 * both incomplete and stale. "Westminster City Council" matches on
 * "city council" whether or not anyone has added Westminster anywhere.
 */
const LOCAL_AUTHORITY_PATTERNS: readonly string[] = [
  'london borough of',
  'royal borough of',
  'city council',
  'borough council',
  'county council',
  'district council',
  'metropolitan borough',
  'city of london corporation',
  'common council of the city of london',
  'transport for london',
  'unitary authority',
  'combined authority',
  'council of the isles',
  'comhairle',
];

/**
 * Markers of a private parking operator.
 *
 * Company suffixes do most of the work: a local authority is never a limited
 * company. The named operators cover the largest firms, whose notices are the
 * ones most often mistaken for council PCNs.
 */
const PRIVATE_OPERATOR_PATTERNS: readonly string[] = [
  ' ltd',
  ' ltd.',
  ' limited',
  ' plc',
  ' llp',
  'parkingeye',
  'euro car parks',
  'smart parking',
  'excel parking',
  'premier park',
  'horizon parking',
  'parking control management',
  'civil enforcement limited',
  'parking collection services',
  'britannia parking',
  'total parking solutions',
  'national car parks',
];

function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Authorities PCNWatch lists, by normalised name. */
const KNOWN_AUTHORITIES = new Map(
  LONDON_AUTHORITIES.map((authority) => [normalise(authority.name), authority.slug]),
);

export function classifyAuthorityName(rawName: string | undefined): AuthorityClassification {
  if (!rawName || rawName.trim() === '') {
    return { kind: 'UNRECOGNISED', authoritySlug: null, matchedOn: null };
  }

  const name = normalise(rawName);

  // A name we hold is the strongest signal available.
  const known = KNOWN_AUTHORITIES.get(name);
  if (known) {
    return { kind: 'LOCAL_AUTHORITY', authoritySlug: known, matchedOn: name };
  }

  // Private operators are checked before the generic council patterns: a firm
  // called "Borough Parking Ltd" must not pass as a borough council.
  const privateMatch = PRIVATE_OPERATOR_PATTERNS.map((p) => p.trim()).find((pattern) =>
    new RegExp(`\\b${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(name),
  );
  if (privateMatch) {
    return { kind: 'PRIVATE_OPERATOR', authoritySlug: null, matchedOn: privateMatch };
  }

  const councilMatch = LOCAL_AUTHORITY_PATTERNS.find((pattern) => name.includes(pattern));
  if (councilMatch) {
    // Recognised as a council, but not one we hold a record for. That is a
    // coverage fact, not a classification one.
    const slug = [...KNOWN_AUTHORITIES.entries()].find(([known]) => name.includes(known))?.[1];
    return { kind: 'LOCAL_AUTHORITY', authoritySlug: slug ?? null, matchedOn: councilMatch };
  }

  // "Anytown Council" with no other qualifier. Weaker than the patterns above
  // but still not something a private operator calls itself.
  if (/\bcouncil\b/.test(name)) {
    return { kind: 'LOCAL_AUTHORITY', authoritySlug: null, matchedOn: 'council' };
  }

  return { kind: 'UNRECOGNISED', authoritySlug: null, matchedOn: null };
}

/**
 * Whether PCNWatch holds reviewed, authority-specific material for a body.
 *
 * Separate from classification on purpose. Today only Camden has enforcement
 * history and a reviewed procedure, and that must not decide whether anyone
 * else's notice is a notice.
 */
export function hasReviewedAuthorityGuidance(slug: string | null): boolean {
  if (!slug) return false;
  const record = LONDON_AUTHORITIES.find((authority) => authority.slug === slug);
  return record?.mapCoverage === 'LIVE' && record.dataSources.length > 0;
}
