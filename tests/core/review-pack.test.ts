import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  INITIAL_LAUNCH_REVIEW,
  allCandidates,
  bundleProgress,
  forReview,
  getCandidate,
  isApproved,
} from '@/core/reference/candidates/store';
import {
  PROPOSITION_KINDS,
  TIER_MAY_ESTABLISH,
} from '@/core/reference/candidates/types';
import { renderReviewBundle } from '../../scripts/review-bundle-markdown';

/**
 * The reviewer's pack, and the provenance behind it.
 *
 * The pack is the artefact a qualified person actually works from, so the thing
 * most worth proving is that it says what the candidates say — a document that
 * has drifted from the code is worse than no document, because it will be
 * trusted. Everything else here holds the line that nothing is approved.
 */

const PACK_PATH = 'docs/legal-review-bundle.md';

describe('the committed pack matches the candidates', () => {
  it('is not stale', () => {
    const committed = readFileSync(PACK_PATH, 'utf8');
    expect(
      committed,
      'docs/legal-review-bundle.md is out of date — run `npm run review:pack`',
    ).toBe(renderReviewBundle());
  });

  it('says in the file itself that it is generated', () => {
    expect(readFileSync(PACK_PATH, 'utf8')).toMatch(/GENERATED FILE\. Do not edit by hand\./);
  });
});

describe('the Initial Launch Review section', () => {
  const pack = readFileSync(PACK_PATH, 'utf8');

  it('carries exactly the ten propositions the launch scenario needs', () => {
    expect(INITIAL_LAUNCH_REVIEW).toHaveLength(10);
    for (const id of INITIAL_LAUNCH_REVIEW) {
      expect(getCandidate(id), `${id} is named for review but is not in the bundle`).toBeDefined();
    }
  });

  it('puts them first, in the order they were set', () => {
    const ordered = forReview().map((c) => c.id);
    expect(ordered.slice(0, INITIAL_LAUNCH_REVIEW.length)).toEqual([...INITIAL_LAUNCH_REVIEW]);
  });

  it('reviews what code 12 alleges before what a suffix on it means', () => {
    // A suffix modifies a contravention. Reviewing "x" before confirming what
    // code 12 alleges is reviewing an adjective without the noun.
    const order = [...INITIAL_LAUNCH_REVIEW];
    expect(order.indexOf('CAND-CODE12-DEFINITION')).toBe(0);
    expect(order.indexOf('CAND-CODE12-DEFINITION')).toBeLessThan(
      order.indexOf('CAND-CODE12-SUFFIXES'),
    );
    expect(order.indexOf('CAND-CODE12-DEFINITION')).toBeLessThan(
      order.indexOf('CAND-CODE12-ELECTRONIC-PAYMENT'),
    );
  });

  it('keeps the code 12 definition exactly as it was, only moved', () => {
    const candidate = getCandidate('CAND-CODE12-DEFINITION')!;
    expect(candidate.kind).toBe('CONTRAVENTION_DEFINITION');
    expect(candidate.applicability.contraventionCodes).toEqual(['12']);
    for (const required of [
      /contravention occurred/i,
      /ground of representation/i,
      /suffix/i,
      /traffic order/i,
    ]) {
      expect(candidate.doesNotEstablish.join(' '), `${required} was dropped`).toMatch(required);
    }
  });

  it('renders them under the Initial Launch Review heading, ahead of the rest', () => {
    const launchAt = pack.indexOf('## Initial Launch Review');
    const restAt = pack.indexOf('## Also awaiting review');
    expect(launchAt).toBeGreaterThan(-1);
    expect(restAt).toBeGreaterThan(launchAt);

    const section = pack.slice(launchAt, restAt);
    for (const id of INITIAL_LAUNCH_REVIEW) {
      expect(section, `${id} is not in the Initial Launch Review section`).toContain(id);
    }
  });

  it('gives every candidate a blank excerpt, comments box, decision and signature', () => {
    for (const candidate of allCandidates()) {
      const at = pack.indexOf(`\`${candidate.id}\``);
      expect(at, `${candidate.id} is missing from the pack`).toBeGreaterThan(-1);
      const section = pack.slice(at, pack.indexOf('\n---\n', at));

      expect(section, `${candidate.id}: no excerpt box`).toMatch(/Bounded excerpt from the source/);
      expect(section, `${candidate.id}: no comments box`).toMatch(/Reviewer comments/);
      expect(section, `${candidate.id}: no decision`).toMatch(/PENDING_LEGAL_REVIEW/);
      expect(section, `${candidate.id}: no reviewer name field`).toMatch(/\| Reviewer name \| \|/);
      expect(section, `${candidate.id}: no date field`).toMatch(/\| Date reviewed \| \|/);

      // And the boxes are empty. A pre-filled excerpt is the failure mode.
      const boxes = section.match(/```\n\n```/g) ?? [];
      expect(boxes.length, `${candidate.id}: an excerpt or comments box is not blank`).toBe(2);
    }
  });

  it('carries the source, proposition, applicability and constraints for each', () => {
    for (const candidate of allCandidates()) {
      const at = pack.indexOf(`\`${candidate.id}\``);
      const section = pack.slice(at, pack.indexOf('\n---\n', at));

      expect(section).toContain(candidate.source.organisation);
      expect(section).toContain(candidate.source.documentTitle);
      expect(section).toContain(candidate.source.canonicalUrl);
      expect(section).toContain(candidate.proposition);
      expect(section).toContain(candidate.reviewQuestion);
      for (const constraint of candidate.doesNotEstablish) expect(section).toContain(constraint);
    }
  });
});

describe('the provenance added for the launch review', () => {
  it('names the 2022 Regulations by SI number where they are the source', () => {
    for (const id of [
      'CAND-TMA-GROUND-NO-CONTRAVENTION',
      'CAND-TMA-GROUND-PAID-DISTINCTION',
      'CAND-DEADLINE-APPEAL-28D',
    ]) {
      const candidate = getCandidate(id)!;
      expect(candidate.source.documentTitle, id).toContain('S.I. 2022/576');
      expect(candidate.source.canonicalUrl, id).toBe('https://www.legislation.gov.uk/uksi/2022/576');
      expect(candidate.source.tier, id).toBe('STATUTORY_INSTRUMENT');
    }
  });

  it('records regulation 7(2) for the appeal period', () => {
    expect(getCandidate('CAND-DEADLINE-APPEAL-28D')!.source.provision).toBe('Regulation 7(2)');
  });

  it('sources mitigation from the Regulations, with the tribunal as a cross-check only', () => {
    const candidate = getCandidate('CAND-MITIGATION-SEPARATE')!;
    expect(candidate.source.tier).toBe('STATUTORY_INSTRUMENT');
    expect(candidate.source.canonicalUrl).toBe('https://www.legislation.gov.uk/uksi/2022/576');
    expect(candidate.source.provision).toBe('Regulation 5(2)(b)(i) and (ii)');
    // Still procedure, so approving it can never make a ground available.
    expect(candidate.kind).toBe('PROCEDURE');
    expect(TIER_MAY_ESTABLISH.STATUTORY_INSTRUMENT).toContain('PROCEDURE');
    // London Tribunals appears in the question as a cross-check, not as the source.
    expect(candidate.reviewQuestion).toMatch(/londontribunals\.gov\.uk/);
    expect(candidate.reviewQuestion).toMatch(/not the source|cross-check/i);
  });

  it('names the exact Westminster page and the heading each policy sits under', () => {
    // The parking hub is a navigation page: two reviewers opening it could
    // have found two different policies. Each candidate now names its heading,
    // so the question is "does the page say this, under this heading".
    const headings: Record<string, string> = {
      'CAND-WCC-INDIVIDUAL-MERITS': 'Merits of the case',
      'CAND-WCC-GENUINE-MISTAKE': 'Genuine mistakes, mitigation and discretion',
      'CAND-WCC-EVIDENCE-CONSIDERED':
        "Full consideration of evidence and the 'balance of probabilities'",
    };
    for (const [id, heading] of Object.entries(headings)) {
      const candidate = getCandidate(id)!;
      expect(candidate.source.organisation, id).toBe('Westminster City Council');
      expect(candidate.source.documentTitle, id).toBe('Consideration of parking ticket challenges');
      expect(candidate.source.canonicalUrl, id).toBe(
        'https://www.westminster.gov.uk/parking/challenge-your-parking-ticket/consideration-parking-ticket-challenges',
      );
      expect(candidate.source.provision, id).toBe(heading);
      expect(candidate.kind, id).toBe('AUTHORITY_POLICY');
      expect(candidate.applicability.authoritySlug, id).toBe('westminster');
    }
  });

  it('applies the incorrect-VRM suffix to the permit contraventions it covers', () => {
    const candidate = getCandidate('CAND-CODE12-SUFFIXES')!;
    expect(candidate.kind).toBe('CONTRAVENTION_METADATA');
    expect(candidate.applicability.contraventionCodes).toEqual(['01', '12', '16', '19', '85']);
  });

  it('leaves the electronic-payment suffix general rather than tied to one code', () => {
    const candidate = getCandidate('CAND-CODE12-ELECTRONIC-PAYMENT')!;
    expect(candidate.kind).toBe('CONTRAVENTION_METADATA');
    expect(candidate.applicability.contraventionCodes).toBeNull();
  });

  it('spells out what each launch candidate does not establish', () => {
    const required: Record<string, RegExp[]> = {
      'CAND-CODE12-SUFFIXES': [/payment was made/i, /did not occur/i, /cancel/i, /statutory ground/i],
      'CAND-CODE12-ELECTRONIC-PAYMENT': [
        /valid parking session/i,
        /correct vehicle/i,
        /correct location/i,
        /correct time/i,
        /cancellation/i,
      ],
      'CAND-WCC-INDIVIDUAL-MERITS': [/statutory right to cancellation/i],
      'CAND-WCC-GENUINE-MISTAKE': [/mandatory|must be cancelled|cancellation is mandatory/i, /statutory ground/i, /guaranteed/i],
      'CAND-TMA-GROUND-NO-CONTRAVENTION': [/I paid for parking/i, /RingGo/i],
      'CAND-TMA-GROUND-PAID-DISTINCTION': [/canStateGrounds/],
      'CAND-MITIGATION-SEPARATE': [/statutory ground/i],
      'CAND-DEADLINE-APPEAL-28D': [/separate rules|discount period/i],
    };
    for (const [id, patterns] of Object.entries(required)) {
      const prose = getCandidate(id)!.doesNotEstablish.join(' ');
      for (const pattern of patterns) {
        expect(prose, `${id} does not disclaim ${pattern}`).toMatch(pattern);
      }
    }
  });
});

describe('nothing in the pack is approved', () => {
  it('leaves every candidate pending, unnamed, unopened and unquoted', () => {
    for (const candidate of allCandidates()) {
      expect(candidate.review.decision, candidate.id).toBe('PENDING_LEGAL_REVIEW');
      expect(candidate.review.reviewer, candidate.id).toBeNull();
      expect(candidate.review.decidedAt, candidate.id).toBeNull();
      expect(candidate.source.retrieval, candidate.id).toBe('NOT_RETRIEVED');
      expect(candidate.source.excerpt, candidate.id).toBeNull();
      expect(candidate.source.retrievedAt, candidate.id).toBeNull();
      expect(isApproved(candidate), candidate.id).toBe(false);
    }
    expect(bundleProgress().usable).toBe(0);
  });

  it('documents every proposition kind in the reviewer guide', () => {
    // A kind added to the code and not to the guide is a kind nobody reviewing
    // knows the meaning of.
    const guide = readFileSync('docs/legal-review.md', 'utf8');
    for (const kind of PROPOSITION_KINDS) {
      expect(guide, `${kind} is not documented in docs/legal-review.md`).toContain(kind);
    }
  });
});
