/**
 * Barnet localities, and the postal district each one names.
 *
 * Barnet and Ordnance Survey both say where a street is; they do not say it the
 * same way. Barnet writes "HIGH ROAD, North Finchley". OS records the same road
 * as High Road, populated place "Finchley", postcode district N12 — and it
 * records a *different* High Road as Finchley / N2. So OS's place name is
 * coarser than Barnet's locality and cannot separate them: mapping both North
 * Finchley and East Finchley onto "Finchley" would merge two genuinely distinct
 * roads, which is the failure this table exists to avoid.
 *
 * The postal district is what separates them, so that is what the locality is
 * mapped to. Each entry is one-to-one, reviewed individually and approved
 * individually. Nothing here is inferred and nothing is derived at run time.
 *
 * Scope, deliberately narrow on all three axes:
 *
 *   * **Barnet only.** These are facts about Barnet's own publishing habits,
 *     not a general gazetteer. No other authority reads this file, and a
 *     shared postcode table would quietly apply one borough's conventions to
 *     another's data.
 *   * **Disambiguation only.** A mapping never supplies a position. It narrows
 *     a candidate set that is already restricted to roads of the right name
 *     inside Barnet; if it does not leave exactly one, the match is still
 *     refused.
 *   * **Never inferred.** There is no rule stripping "North" or "East" off a
 *     locality, no similarity measure and no fallback. A locality absent from
 *     this table is simply not used as a postcode constraint.
 *
 * Two entries were deliberately left out after review, and the reasons are
 * worth keeping:
 *
 *   * **Mill Hill → NW7** was measured and rejected. It would have resolved
 *     ~1,049 notices but broke `HALE LANE, Mill Hill`, which straddles the
 *     NW7/HA8 boundary and which OS files outside NW7 — turning a resolved
 *     street into a postcode conflict. A rule that contradicts the gazetteer
 *     for a real street is not safe as a blanket rule.
 *   * **Hendon → NW4 and Finchley → N3** resolve nothing today. An untested
 *     mapping that fires on no data is a liability with no benefit; either can
 *     be added when a real unresolved location needs it.
 */

/**
 * Approved mappings. The key is the locality exactly as Barnet writes it,
 * upper-cased; the value is the postal district as Ordnance Survey records it.
 */
const BARNET_LOCALITY_DISTRICTS: Readonly<Record<string, string>> = {
  'NORTH FINCHLEY': 'N12',
  'GOLDERS GREEN': 'NW11',
  WHETSTONE: 'N20',
  EDGWARE: 'HA8',
  'EAST FINCHLEY': 'N2',
  'THE HYDE': 'NW9',
  CRICKLEWOOD: 'NW2',
  'NEW SOUTHGATE': 'N11',
  'NEW BARNET': 'EN5',
};

/**
 * The postal district a Barnet locality names, or null.
 *
 * Case-insensitive on the locality because Barnet is inconsistent about it, and
 * exact on everything else: an unlisted locality returns null rather than
 * anything approximate.
 */
export function districtForBarnetLocality(locality: string | null | undefined): string | null {
  if (!locality) return null;
  return BARNET_LOCALITY_DISTRICTS[locality.trim().toUpperCase()] ?? null;
}

/** The approved mappings, for tests and for review. */
export function approvedLocalityDistricts(): Readonly<Record<string, string>> {
  return BARNET_LOCALITY_DISTRICTS;
}
