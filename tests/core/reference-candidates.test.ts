import { describe, expect, it } from 'vitest';
import {
  allCandidates,
  applicableApproved,
  bundleProgress,
  hasApprovedStatutoryGround,
  isApproved,
} from '@/core/reference/candidates/store';
import {
  TIER_MAY_ESTABLISH,
  type CandidateProposition,
} from '@/core/reference/candidates/types';

/**
 * What a candidate proposition may and may not do.
 *
 * The bundle is unreviewed and stays that way until a qualified person works
 * through it, so most of these prove a refusal. That is the point: the value of
 * this layer before anything is approved is that it changes nothing, and the
 * value after is that it changes exactly one thing at a time.
 */

const WESTMINSTER_CODE_12 = {
  contraventionCode: '12',
  authoritySlug: 'westminster',
  noticeType: 'NOTICE_TO_OWNER',
  proceduralStage: 'FORMAL_REPRESENTATION',
};

/** An approved candidate, built by hand. Nothing in the bundle is one. */
function approved(overrides: Partial<CandidateProposition> = {}): CandidateProposition {
  const base = allCandidates().find((c) => c.id === 'CAND-TMA-GROUND-NO-CONTRAVENTION')!;
  return {
    ...base,
    review: {
      decision: 'REVIEWED',
      reviewer: 'A. Reviewer, solicitor',
      decidedAt: '2026-03-01',
      note: null,
    },
    source: {
      ...base.source,
      retrieval: 'RETRIEVED',
      retrievedAt: '2026-03-01',
      excerpt: '(verbatim wording recorded by the reviewer)',
    },
    ...overrides,
  };
}

describe('the bundle as prepared', () => {
  it('is entirely unreviewed', () => {
    // A model prepared these. A model may not approve one.
    for (const candidate of allCandidates()) {
      expect(candidate.review.decision, candidate.id).toBe('PENDING_LEGAL_REVIEW');
      expect(candidate.review.reviewer, candidate.id).toBeNull();
    }
    expect(bundleProgress().usable).toBe(0);
  });

  it('carries no source text, because no source was opened', () => {
    /*
     * The egress proxy refused every authoritative domain. An excerpt written
     * from a model's recollection would look exactly like evidence that
     * somebody had checked, which is the one artefact this whole architecture
     * exists to prevent.
     */
    for (const candidate of allCandidates()) {
      expect(candidate.source.retrieval, candidate.id).toBe('NOT_RETRIEVED');
      expect(candidate.source.excerpt, candidate.id).toBeNull();
      expect(candidate.source.retrievedAt, candidate.id).toBeNull();
    }
  });

  it('names a source a reviewer can actually open', () => {
    for (const candidate of allCandidates()) {
      expect(candidate.source.canonicalUrl, candidate.id).toMatch(/^https:\/\//);
      expect(candidate.source.organisation, candidate.id).not.toBe('');
      expect(candidate.source.documentTitle, candidate.id).not.toBe('');
    }
  });

  it('comes only from authoritative organisations', () => {
    /*
     * legislation.gov.uk, London Councils, the issuing authority, and the
     * adjudicator. One domain per source tier, and there is no tier for a blog,
     * a forum or a solicitor's marketing page — so there is no way to record
     * one as the basis of an approved proposition.
     *
     * londontribunals.gov.uk was added when the mitigation candidate was
     * sourced from the adjudicator's own description of the process. The
     * TRIBUNAL tier already existed for exactly that, and is competent for
     * PROCEDURE and nothing that resembles a statement of law.
     */
    const ALLOWED = [
      'legislation.gov.uk',
      'londoncouncils.gov.uk',
      'westminster.gov.uk',
      'londontribunals.gov.uk',
    ];
    for (const candidate of allCandidates()) {
      const host = new URL(candidate.source.canonicalUrl).hostname.replace(/^www\./, '');
      expect(ALLOWED, `${candidate.id} cites ${host}`).toContain(host);
    }
  });

  it('says what each proposition must not be read as establishing', () => {
    for (const candidate of allCandidates()) {
      expect(candidate.doesNotEstablish.length, candidate.id).toBeGreaterThan(0);
    }
  });

  it('asks one question per candidate', () => {
    // Small enough that approving it is a single decision. A paragraph
    // covering a definition and a policy cannot be approved by halves.
    for (const candidate of allCandidates()) {
      expect(candidate.proposition.length, candidate.id).toBeLessThan(400);
    }
  });
});

describe('a pending candidate cannot enter legal reasoning', () => {
  it('is not approved', () => {
    for (const candidate of allCandidates()) expect(isApproved(candidate)).toBe(false);
  });

  it('gives the Westminster code 12 case no statutory ground', () => {
    expect(hasApprovedStatutoryGround(WESTMINSTER_CODE_12)).toBe(false);
    expect(applicableApproved(WESTMINSTER_CODE_12)).toEqual([]);
  });
});

describe('what approval requires', () => {
  it('accepts a candidate a named reviewer approved against a source they opened', () => {
    expect(isApproved(approved())).toBe(true);
  });

  it('refuses an approval with no reviewer named', () => {
    expect(
      isApproved(approved({ review: { decision: 'REVIEWED', reviewer: null, decidedAt: '2026-03-01', note: null } })),
    ).toBe(false);
  });

  it('refuses an approval where nobody opened the source', () => {
    /*
     * `decision` is a field a script could set. Retrieval plus an excerpt is
     * the evidence the decision meant something, which is why both are
     * required rather than either.
     */
    const base = approved();
    expect(
      isApproved({ ...base, source: { ...base.source, retrieval: 'NOT_RETRIEVED' } }),
    ).toBe(false);
    expect(isApproved({ ...base, source: { ...base.source, excerpt: null } })).toBe(false);
  });

  it('refuses a rejected or superseded candidate', () => {
    const base = approved();
    for (const decision of ['REJECTED', 'NEEDS_CHANGE', 'PENDING_LEGAL_REVIEW'] as const) {
      expect(isApproved({ ...base, review: { ...base.review, decision } }), decision).toBe(false);
    }
    expect(isApproved({ ...base, supersededBy: 'CAND-SOMETHING-NEWER' })).toBe(false);
  });

  it('refuses a source that is not competent to establish that kind of thing', () => {
    /*
     * An authority's own policy page is authoritative about that authority's
     * practice and cannot become a statutory ground however it is worded. This
     * is the distinction the whole bundle is organised around.
     */
    const base = approved();
    expect(
      isApproved({ ...base, source: { ...base.source, tier: 'ISSUING_AUTHORITY_POLICY' } }),
    ).toBe(false);
    expect(TIER_MAY_ESTABLISH.ISSUING_AUTHORITY_POLICY).not.toContain('STATUTORY_GROUND');
    expect(TIER_MAY_ESTABLISH.LONDON_COUNCILS_FRAMEWORK).not.toContain('STATUTORY_GROUND');
  });
});

describe('approval is granular', () => {
  const ground = approved();

  it('applies only where the candidate says it applies', () => {
    expect(applicableApproved(WESTMINSTER_CODE_12, 'STATUTORY_GROUND')).toEqual([]);
    // With it approved, it reaches the stage it was reviewed for.
    const at = (scenario: typeof WESTMINSTER_CODE_12) =>
      [ground].filter(
        (c) =>
          isApproved(c) &&
          (c.applicability.proceduralStages ?? []).includes(scenario.proceduralStage as never),
      );
    expect(at(WESTMINSTER_CODE_12)).toHaveLength(1);
    expect(at({ ...WESTMINSTER_CODE_12, proceduralStage: 'INFORMAL_CHALLENGE' })).toHaveLength(0);
  });

  it('does not let one approved ground enable anything else', () => {
    /*
     * Approving "the contravention did not occur" says nothing about the
     * payment ground, which is a different provision with different words.
     *
     * This used to look only at other STATUTORY_GROUND candidates. Since the
     * already-paid distinction and the ground list were reclassified as
     * STATUTORY_GROUND_INTERPRETATION — so that approving either cannot switch
     * statutory drafting on — that filter matched nothing and the test passed
     * vacuously. It now asserts the stronger and still-true property: one
     * approval approves one candidate, whatever kind the others are.
     */
    const others = allCandidates().filter((c) => c.id !== ground.id);
    expect(others.length).toBe(13);
    for (const other of others) expect(isApproved(other), other.id).toBe(false);

    // And specifically the two that used to share this kind.
    for (const id of ['CAND-TMA-GROUND-LIST', 'CAND-TMA-GROUND-PAID-DISTINCTION']) {
      const candidate = allCandidates().find((c) => c.id === id)!;
      expect(candidate.kind, `${id} must not be able to unlock statutory drafting`).toBe(
        'STATUTORY_GROUND_INTERPRETATION',
      );
    }
  });

  it('does not let a Westminster policy carry to another authority', () => {
    const policy = allCandidates().find((c) => c.id === 'CAND-WCC-GENUINE-MISTAKE')!;
    expect(policy.applicability.authoritySlug).toBe('westminster');
    expect(policy.kind).toBe('AUTHORITY_POLICY');
  });

  it('keeps a deadline rule needing its own review', () => {
    const deadlines = allCandidates().filter((c) => c.kind === 'DEADLINE_RULE');
    expect(deadlines.length).toBeGreaterThan(0);
    for (const rule of deadlines) expect(isApproved(rule)).toBe(false);
    // And approving a ground does not approve a period.
    expect(isApproved(ground)).toBe(true);
    for (const rule of deadlines) expect(isApproved(rule)).toBe(false);
  });
});

describe('the incorrect-registration scenario', () => {
  const vrmRelevant = ['CAND-CODE12-ELECTRONIC-PAYMENT', 'CAND-TMA-GROUND-NO-CONTRAVENTION', 'CAND-WCC-GENUINE-MISTAKE'];

  it('never implies cancellation is mandatory', () => {
    for (const id of vrmRelevant) {
      const candidate = allCandidates().find((c) => c.id === id)!;
      const prose = `${candidate.proposition} ${candidate.reviewQuestion}`;
      for (const forbidden of [/must cancel/i, /will be cancelled/i, /entitled to cancellation/i]) {
        expect(prose, `${id} implies mandatory cancellation`).not.toMatch(forbidden);
      }
      // Each must disclaim compulsion in its own words. "must be cancelled"
      // is the phrasing the suffix candidates use, and is exactly as explicit
      // a denial as "mandatory" would be.
      expect(candidate.doesNotEstablish.join(' '), `${id} disclaims no compulsion`).toMatch(
        /oblige|mandator|must be cancelled|did not occur|entitlement|adjudicator/i,
      );
    }
  });

  it('keeps Westminster discretion out of the statutory category', () => {
    /*
     * The dangerous conflation. A published willingness to consider a genuine
     * mistake is discretion; a ground of representation is an entitlement to
     * have something considered. This bundle keeps them in different kinds,
     * sourced from different tiers, approved separately.
     */
    for (const candidate of allCandidates()) {
      if (candidate.source.tier !== 'ISSUING_AUTHORITY_POLICY') continue;
      expect(candidate.kind, candidate.id).not.toBe('STATUTORY_GROUND');
      expect(candidate.kind, candidate.id).toBe('AUTHORITY_POLICY');
    }
  });

  it('does not claim a payment mismatch means no contravention occurred', () => {
    const ground = allCandidates().find((c) => c.id === 'CAND-TMA-GROUND-NO-CONTRAVENTION')!;
    expect(ground.doesNotEstablish.join(' ')).toMatch(
      /payment made against a different registration/i,
    );
  });

  it('keeps the parking payment and the penalty payment apart', () => {
    // A user who paid by app has not paid the penalty. Sending a representation
    // on a payment ground that means the latter would be a real harm.
    const candidate = allCandidates().find((c) => c.id === 'CAND-TMA-GROUND-PAID-DISTINCTION')!;
    expect(candidate.reviewQuestion).toMatch(/GROUND-ALREADY_PAID/);
    expect(candidate.doesNotEstablish.join(' ')).toMatch(/paying for parking engages any ground/i);
  });
});
