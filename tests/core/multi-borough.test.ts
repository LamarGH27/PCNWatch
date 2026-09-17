import { describe, expect, it } from 'vitest';
import {
  authorityArea,
  coveredAreaAt,
  coveredAreaLabel,
  coveredAreas,
  isWithinCoverage,
  liveAuthoritiesWithoutArea,
  registeredAreas,
  COVERED_AUTHORITY_NAME,
  OUTSIDE_COVERAGE_MESSAGE,
  type AuthorityArea,
} from '@/core/coverage/area';
import { COVERAGE_SCOPE } from '@/core/coverage/coverage';
import {
  getSource,
  isOfficialSourceUrl,
  knownSourceSlugs,
  listSources,
  requireSource,
  UnknownSourceError,
} from '@/data-sources/registry';
import { CAMDEN_SOURCE, CAMDEN_AUTHORITY_SLUG } from '@/data-sources/camden/adapter';
import { CAMDEN_BBOX } from '@/data-sources/camden/schema';
import { withinBounds } from '@/core/geography/types';

/**
 * The multi-borough seam.
 *
 * Two things are being protected here and they pull in opposite directions.
 * The structure has to be plural, so a second borough is data rather than a
 * second code path. And the *behaviour* has to be identical to the Camden-only
 * version it replaced, because Camden is in Production and none of this is
 * meant to reach a user.
 *
 * So most of these assert sameness, not capability.
 */

describe('Camden behaviour is unchanged', () => {
  it('still covers exactly one authority, and it is Camden', () => {
    expect(COVERAGE_SCOPE.liveAuthoritySlugs).toEqual(['camden']);
    expect(coveredAreas().map((a) => a.slug)).toEqual(['camden']);
  });

  it('still names Camden in the coverage constants, character for character', () => {
    // These two strings reach real users, on the map and in search results.
    expect(COVERED_AUTHORITY_NAME).toBe('Camden');
    expect(OUTSIDE_COVERAGE_MESSAGE).toBe(
      'Location found. PCNWatch enforcement data currently covers Camden only, ' +
        'so no activity is shown here — that is a gap in our data, not a statement that no ' +
        'penalty charge notices are issued in this area.',
    );
  });

  it('still answers the same coordinates the same way', () => {
    // The exact cases the single-borough implementation was tested on.
    expect(isWithinCoverage(-0.1355, 51.5305)).toBe(true); // Camden
    expect(isWithinCoverage(-2.2374, 53.4808)).toBe(false); // Manchester
    expect(isWithinCoverage(-0.0198, 51.5033)).toBe(false); // Canary Wharf
  });

  it('keeps Camden bounds identical to the values the borough was launched on', () => {
    expect(authorityArea('camden')?.bounds).toEqual({
      minLon: -0.24,
      minLat: 51.5,
      maxLon: -0.08,
      maxLat: 51.6,
    });
  });

  it('has one definition of Camden bounds, not two that can drift', () => {
    // `CAMDEN_BBOX` and the coverage rectangle were separately written out and
    // happened to agree. Now one reads the other, so they cannot stop agreeing.
    expect(CAMDEN_BBOX).toBe(authorityArea('camden')?.bounds);
    expect(CAMDEN_SOURCE.bounds).toBe(CAMDEN_BBOX);
  });
});

describe('coverage is plural in structure', () => {
  const barnet: AuthorityArea = {
    slug: 'barnet',
    name: 'Barnet',
    bounds: { minLon: -0.3, minLat: 51.56, maxLon: -0.13, maxLat: 51.67 },
  };

  it('reports which area a point is in, not merely that it is in one', () => {
    expect(coveredAreaAt(-0.1355, 51.5305)?.slug).toBe('camden');
    expect(coveredAreaAt(-2.2374, 53.4808)).toBeNull();
  });

  it('builds a label for one, two or many areas', () => {
    const camden = authorityArea('camden') as AuthorityArea;
    const third: AuthorityArea = { ...barnet, slug: 'x', name: 'Ealing' };
    expect(coveredAreaLabel([camden])).toBe('Camden');
    expect(coveredAreaLabel([camden, barnet])).toBe('Camden and Barnet');
    expect(coveredAreaLabel([camden, barnet, third])).toBe('Camden, Barnet and Ealing');
    expect(coveredAreaLabel([])).toBe('no areas');
  });
});

describe('an unlaunched borough is invisible', () => {
  it('registers no coverage area for Barnet', () => {
    // Barnet publishes no coordinates in any of its three datasets, so there is
    // nothing to bound and nowhere on a map to put it. An area here would be a
    // rectangle asserting an extent the data never describes.
    expect(authorityArea('barnet')).toBeNull();
    expect(registeredAreas().map((a) => a.slug)).toEqual(['camden']);
  });

  it('does not treat northern Barnet as covered', () => {
    // High Barnet, comfortably north of Camden's rectangle.
    expect(isWithinCoverage(-0.199, 51.65)).toBe(false);
    expect(coveredAreaAt(-0.199, 51.65)).toBeNull();
  });

  it('still reports Camden for a point Camden\'s generous box already reached', () => {
    /*
     * Hendon is in Barnet, and Camden's rectangle covers it — the box was
     * always deliberately larger than the borough, to err towards "we have
     * data here" at the edges. That is unchanged behaviour, not a new claim
     * about Barnet: nothing in the product will say "Barnet" until Barnet is
     * registered and live.
     *
     * Pinned because it is the case that will need deciding when a second
     * borough is added, and it should be decided deliberately rather than
     * discovered from whichever entry the registry happened to list first.
     */
    expect(coveredAreaAt(-0.2268, 51.5833)?.slug).toBe('camden');
    expect(coveredAreaAt(-0.2268, 51.5833)?.name).toBe('Camden');
  });

  it('never mentions Barnet in anything a user reads', () => {
    expect(COVERED_AUTHORITY_NAME.toLowerCase()).not.toContain('barnet');
    expect(OUTSIDE_COVERAGE_MESSAGE.toLowerCase()).not.toContain('barnet');
  });

  it('has no live authority lacking registered geography', () => {
    /*
     * The failure this exists to catch: a borough added to the live list whose
     * extent nobody registered. The map would serve its data while the search
     * told people it was outside coverage, and neither surface would be wrong
     * on its own terms.
     */
    expect(liveAuthoritiesWithoutArea()).toEqual([]);
  });
});

describe('the source registry fails closed', () => {
  it('knows exactly the sources that have been registered', () => {
    expect(knownSourceSlugs()).toEqual(['camden-pcn', 'barnet-pcn']);
    expect(listSources()).toHaveLength(2);
  });

  it('registers Barnet without making it visible', () => {
    /*
     * The separation the registry exists for. Barnet's datasets are verified
     * and ingestible, so it belongs here; whether anyone is told Barnet exists
     * is `liveAuthoritySlugs`, which still names only Camden. Being ingestible
     * and being shown are different decisions, and this is the test that says
     * one does not imply the other.
     */
    expect(getSource('barnet-pcn')?.authoritySlug).toBe('barnet');
    expect(COVERAGE_SCOPE.liveAuthoritySlugs).not.toContain('barnet');
    expect(coveredAreas().map((a) => a.slug)).toEqual(['camden']);
  });

  it('refuses an unregistered source by name rather than defaulting', () => {
    // The dangerous failure is a typo silently ingesting one borough's dataset
    // and attributing it to another. Nothing downstream could detect that.
    expect(getSource('haringey-pcn')).toBeNull();
    expect(() => requireSource('haringey-pcn')).toThrow(UnknownSourceError);
    expect(() => requireSource('haringey-pcn')).toThrow(/Known sources: camden-pcn/);
  });

  it('refuses an empty or near-miss slug', () => {
    for (const slug of ['', 'camden', 'CAMDEN-PCN', 'camden-pcn ', 'barnet', 'BARNET-PCN']) {
      expect(getSource(slug)).toBeNull();
    }
  });

  it('points Camden at the right authority and publisher host', () => {
    const camden = requireSource('camden-pcn');
    expect(camden.authoritySlug).toBe(CAMDEN_AUTHORITY_SLUG);
    expect(camden.authoritySlug).toBe('camden');
    expect(isOfficialSourceUrl(camden, 'https://opendata.camden.gov.uk/resource/4k7m-4gkk.json')).toBe(
      true,
    );
  });

  it('treats any other host as unofficial, so the run is recorded as demo', () => {
    const camden = requireSource('camden-pcn');
    for (const url of [
      'https://example.com/rows.json',
      'https://opendata.camden.gov.uk.evil.test/rows.json',
      'not a url',
      '',
    ]) {
      expect(isOfficialSourceUrl(camden, url)).toBe(false);
    }
  });
});

describe('bounds are owned by the source, not by the pipeline', () => {
  it('lets Camden declare its own extent', () => {
    expect(CAMDEN_SOURCE.bounds).toBeTruthy();
    expect(withinBounds(CAMDEN_SOURCE.bounds!, -0.1355, 51.5305)).toBe(true);
    expect(withinBounds(CAMDEN_SOURCE.bounds!, -2.2374, 53.4808)).toBe(false);
  });

  it('treats every edge of a box as inside it', () => {
    const box = { minLon: -1, minLat: 50, maxLon: 1, maxLat: 52 };
    expect(withinBounds(box, -1, 50)).toBe(true);
    expect(withinBounds(box, 1, 52)).toBe(true);
    expect(withinBounds(box, -1.0001, 51)).toBe(false);
    expect(withinBounds(box, 0, 52.0001)).toBe(false);
  });
});
