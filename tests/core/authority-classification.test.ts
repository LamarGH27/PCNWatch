import { describe, expect, it } from 'vitest';
import { classifyAuthorityName, hasReviewedAuthorityGuidance } from '@/core/notices/classify-authority';
import { AUTHORITY_ALIASES } from '@/core/notices/authority-aliases';
import { LONDON_AUTHORITIES } from '@/server/repositories/authorities-data';

/**
 * Who issued the notice.
 *
 * A real Westminster PCN reached the assessment as an unidentifiable document
 * because the classifier matched "city council" and not "city of". The names
 * are both genuine: "City of Westminster" is the corporate name, "Westminster
 * City Council" is how it usually styles itself.
 *
 * The fix is a reviewed list of specific names, not a rule about the words
 * "city of" — and most of what follows is about that distinction holding.
 * Getting it wrong in the other direction means telling somebody a private
 * parking invoice is a statutory penalty charge notice, which changes what they
 * believe their rights and deadlines are.
 */

describe('the names that were failing', () => {
  it('recognises the City of Westminster', () => {
    const result = classifyAuthorityName('City of Westminster');
    expect(result.kind).toBe('LOCAL_AUTHORITY');
    // We hold a record for this one, so the slug is real.
    expect(result.authoritySlug).toBe('westminster');
  });

  it('still recognises Westminster City Council', () => {
    const result = classifyAuthorityName('Westminster City Council');
    expect(result.kind).toBe('LOCAL_AUTHORITY');
    expect(result.authoritySlug).toBe('westminster');
  });

  it('reaches the same authority by either name', () => {
    expect(classifyAuthorityName('City of Westminster').authoritySlug).toBe(
      classifyAuthorityName('Westminster City Council').authoritySlug,
    );
  });

  it('recognises the City of London, by each of its names', () => {
    for (const name of [
      'City of London',
      'City of London Corporation',
      'Mayor and Commonalty and Citizens of the City of London',
    ]) {
      expect(classifyAuthorityName(name).kind, `${name} was not recognised`).toBe('LOCAL_AUTHORITY');
    }
  });

  it('claims no slug for an authority it holds no record for', () => {
    /*
     * The City of London Corporation is a real authority and PCNWatch lists
     * nothing about it. A slug here would read downstream as "we know this
     * place", when the only true statement is "this is a council".
     */
    const result = classifyAuthorityName('City of London');
    expect(result.authoritySlug).toBeNull();
    expect(hasReviewedAuthorityGuidance(result.authoritySlug)).toBe(false);
  });

  it('handles the suffixes notices actually carry', () => {
    // Notices arrive headed "City of Westminster — Parking Services" rather
    // than with the bare corporate name.
    const result = classifyAuthorityName('City of Westminster Parking Services');
    expect(result.kind).toBe('LOCAL_AUTHORITY');
    expect(result.authoritySlug).toBe('westminster');
  });
});

describe('it is a list, not a rule about "city of"', () => {
  it('does not recognise an arbitrary "City of" name', () => {
    /*
     * The test that matters most. A heuristic treating every "City of X" as an
     * authority would pass every other test in this file and would also accept
     * anything a private operator chose to print.
     */
    for (const name of [
      'City of Atlantis',
      'City of Springfield',
      'City of Westminster Parking Solutions Group',
      'City Parking',
      'Cityscape Parking',
      'City of the Dead',
    ]) {
      const result = classifyAuthorityName(name);
      if (name === 'City of Westminster Parking Solutions Group') {
        // This one does contain a reviewed name, so it is recognised. Recorded
        // rather than hidden: a private firm trading under a council's own name
        // would be passing off, and the ordering below refuses the realistic form.
        expect(result.kind).toBe('LOCAL_AUTHORITY');
        continue;
      }
      expect(result.kind, `${name} was accepted as an authority`).not.toBe('LOCAL_AUTHORITY');
    }
  });

  it('keeps the list short and each entry checkable', () => {
    // Every entry names a specific body and says why it is legitimate, so a
    // reviewer can verify it against that authority's own publications rather
    // than trusting the list.
    expect(AUTHORITY_ALIASES.length).toBeLessThanOrEqual(12);
    for (const alias of AUTHORITY_ALIASES) {
      expect(alias.name.trim(), 'an alias has no name').not.toBe('');
      expect(alias.note.length, `${alias.name} has no note explaining it`).toBeGreaterThan(40);
    }
  });

  it('claims a slug only where a record exists', () => {
    const slugs = new Set(LONDON_AUTHORITIES.map((a) => a.slug));
    for (const alias of AUTHORITY_ALIASES) {
      if (alias.slug === null) continue;
      expect(slugs.has(alias.slug), `${alias.name} points at a slug with no record`).toBe(true);
    }
  });
});

describe('private operators are still private', () => {
  it('refuses a limited company however it is named', () => {
    for (const name of [
      'ParkingEye Ltd',
      'Euro Car Parks',
      'Smart Parking Limited',
      'Civil Enforcement Limited',
      'Britannia Parking Group Ltd',
    ]) {
      expect(classifyAuthorityName(name).kind, `${name} passed as an authority`).toBe(
        'PRIVATE_OPERATOR',
      );
    }
  });

  it('refuses a company that has put a council name in front of its own', () => {
    /*
     * The ordering that makes the alias list safe: private markers are checked
     * first, so "City of Westminster Parking Ltd" is a limited company whatever
     * it printed before the "Ltd".
     */
    for (const name of [
      'City of Westminster Parking Ltd',
      'City of London Parking Services Limited',
      'Westminster City Council Parking Ltd',
    ]) {
      expect(classifyAuthorityName(name).kind, `${name} passed as an authority`).toBe(
        'PRIVATE_OPERATOR',
      );
    }
  });
});

describe('everything that already worked still does', () => {
  it('recognises every authority in the directory by its own name', () => {
    for (const authority of LONDON_AUTHORITIES) {
      const result = classifyAuthorityName(authority.name);
      expect(result.kind, `${authority.name} was not recognised`).toBe('LOCAL_AUTHORITY');
      expect(result.authoritySlug, `${authority.name} resolved the wrong record`).toBe(
        authority.slug,
      );
    }
  });

  it('recognises councils it holds no record for, structurally', () => {
    for (const name of [
      'Manchester City Council',
      'Kent County Council',
      'Sheffield Metropolitan Borough Council',
      'Transport for London',
      'City of Bradford Metropolitan District Council',
      'City of York Council',
    ]) {
      expect(classifyAuthorityName(name).kind, `${name} was not recognised`).toBe(
        'LOCAL_AUTHORITY',
      );
    }
  });

  it('leaves an ambiguous name unrecognised', () => {
    for (const name of ['Acme Holdings', 'Parking Services', '', '   ', 'Enforcement Department']) {
      expect(classifyAuthorityName(name).kind, `${name} was classified`).not.toBe(
        'LOCAL_AUTHORITY',
      );
    }
    expect(classifyAuthorityName(undefined).kind).toBe('UNRECOGNISED');
  });
});

describe('coverage plays no part in classification', () => {
  it('recognises boroughs PCNWatch holds no enforcement data for', () => {
    /*
     * The distinction this classifier exists for. Camden is the only borough
     * with enforcement history; every other one issues PCNs under the same
     * statute and must classify identically.
     */
    const uncovered = LONDON_AUTHORITIES.filter((a) => a.mapCoverage !== 'LIVE');
    expect(uncovered.length).toBeGreaterThan(0);

    for (const authority of uncovered) {
      expect(classifyAuthorityName(authority.name).kind).toBe('LOCAL_AUTHORITY');
      // Recognised, and honestly reported as something we hold nothing about.
      expect(hasReviewedAuthorityGuidance(authority.slug)).toBe(false);
    }
  });

  it('classifies the same whether or not guidance exists', () => {
    const camden = classifyAuthorityName('London Borough of Camden');
    const westminster = classifyAuthorityName('City of Westminster');

    expect(camden.kind).toBe(westminster.kind);
    // They differ only in what we hold, which is a separate question asked by a
    // separate function.
    expect(hasReviewedAuthorityGuidance(camden.authoritySlug)).toBe(true);
    expect(hasReviewedAuthorityGuidance(westminster.authoritySlug)).toBe(false);
  });
});
