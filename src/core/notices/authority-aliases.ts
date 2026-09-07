/**
 * Legal authority names that no structural pattern can catch.
 *
 * The classifier works structurally — "london borough of", "city council",
 * "county council" — because there are around 300 English billing authorities
 * plus Wales and Scotland, and a list of all of them would be both incomplete
 * and permanently out of date. That approach covers almost everything.
 *
 * It does not cover a body whose legal name simply does not contain any of
 * those words. "City of Westminster" is the corporate name of the authority
 * that issues Westminster PCNs; "Westminster City Council" is how it usually
 * styles itself, and only the second matched. A real notice reached the
 * assessment as an unidentifiable document because of the difference.
 *
 * The fix is this list and not a rule about the words "city of". A rule like
 * that would sweep in anything a private operator chose to call itself, and
 * the failure mode of getting this wrong is telling somebody a private parking
 * invoice is a statutory penalty charge notice — which changes what they think
 * their rights and deadlines are. So each entry below is a specific name a
 * person can check against the authority's own publications, added
 * deliberately, and nothing is inferred from its shape.
 *
 * The list is short by design and expected to stay that way: these are the
 * cases where a real authority's name looks like nothing in particular.
 */

export interface AuthorityAlias {
  /** The name as it would appear on a notice, before normalisation. */
  readonly name: string;
  /**
   * The authority record this belongs to, when PCNWatch lists one.
   *
   * Null where the body is a real authority we hold no record for — the City
   * of London is one. A slug pointing at nothing would be worse than none: it
   * reads as "we know about this place" to everything downstream, when what is
   * true is only "this is a council".
   */
  readonly slug: string | null;
  /** Why this name is legitimate, so a reviewer can check it rather than trust it. */
  readonly note: string;
}

export const AUTHORITY_ALIASES: readonly AuthorityAlias[] = [
  {
    name: 'City of Westminster',
    slug: 'westminster',
    note:
      'The corporate name of the City of Westminster, which issues PCNs as ' +
      'Westminster City Council. Both appear on its own notices and website.',
  },
  {
    name: 'City of London',
    slug: null,
    note:
      'The City of London Corporation is the local authority for the Square ' +
      'Mile and issues its own PCNs. PCNWatch holds no record for it, so no ' +
      'slug is claimed.',
  },
  {
    name: 'City of London Corporation',
    slug: null,
    note:
      'The Corporation’s usual modern styling. Already matched structurally; ' +
      'listed here so it resolves the same way as the short form rather than by ' +
      'a different route.',
  },
  {
    name: 'Mayor and Commonalty and Citizens of the City of London',
    slug: null,
    note:
      'The Corporation’s full legal name, which appears on formal ' +
      'correspondence such as charge certificates.',
  },
];
