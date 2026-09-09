import {
  TIER_MAY_ESTABLISH,
  type Applicability,
  type CandidateProposition,
  type PropositionKind,
} from './types';
import { CODE_12_WESTMINSTER_BUNDLE, INITIAL_LAUNCH_REVIEW } from './code-12-westminster';

/**
 * The candidate store, and the four conditions a proposition passes before
 * PCNWatch will say it.
 *
 * Read `isApproved` first: it is the whole safety model of this feature in five
 * lines, and everything else here exists to serve it.
 */

export const CANDIDATE_PROPOSITIONS: readonly CandidateProposition[] =
  CODE_12_WESTMINSTER_BUNDLE;

export function allCandidates(): readonly CandidateProposition[] {
  return CANDIDATE_PROPOSITIONS;
}

export { INITIAL_LAUNCH_REVIEW };

/**
 * The bundle ordered for a review sitting: the launch nine first, in the order
 * they were set, then everything else.
 */
export function forReview(): readonly CandidateProposition[] {
  const rank = (id: string) => {
    const index = INITIAL_LAUNCH_REVIEW.indexOf(id);
    return index === -1 ? INITIAL_LAUNCH_REVIEW.length : index;
  };
  return [...CANDIDATE_PROPOSITIONS].sort((a, b) => rank(a.id) - rank(b.id));
}

export function getCandidate(id: string): CandidateProposition | undefined {
  return CANDIDATE_PROPOSITIONS.find((c) => c.id === id);
}

/**
 * Whether PCNWatch may state this proposition.
 *
 * Four conditions, and each closes a different way this could go wrong:
 *
 *   1. A person decided REVIEWED. Not a script, not a model, not a default.
 *   2. Somebody actually opened the source. `decision` is a field; retrieval
 *      plus an excerpt is the evidence that the decision meant anything, and
 *      requiring it means a candidate prepared without source access cannot be
 *      approved into use by editing one word.
 *   3. Nothing has replaced it.
 *   4. The source is competent to establish this kind of proposition. An
 *      authority's own policy page is authoritative about that authority's
 *      practice and cannot become a statutory ground however it is worded.
 */
export function isApproved(candidate: CandidateProposition): boolean {
  if (candidate.review.decision !== 'REVIEWED') return false;
  if (candidate.review.reviewer === null) return false;
  if (candidate.source.retrieval !== 'RETRIEVED') return false;
  if (candidate.source.excerpt === null) return false;
  if (candidate.supersededBy !== null) return false;
  return TIER_MAY_ESTABLISH[candidate.source.tier].includes(candidate.kind);
}

/** The case a proposition is being considered for. */
export interface PropositionScenario {
  readonly contraventionCode: string | null;
  readonly authoritySlug: string | null;
  readonly noticeType: string | null;
  readonly proceduralStage: string | null;
}

function applies(applicability: Applicability, scenario: PropositionScenario): boolean {
  /*
   * Null means "any". An empty list means "none", which is different and is
   * how a proposition can be approved and still never apply to anything —
   * a state worth being able to express while a reviewer works out the scope.
   */
  const { contraventionCodes, authoritySlug, noticeTypes, proceduralStages } = applicability;

  if (contraventionCodes !== null) {
    if (scenario.contraventionCode === null) return false;
    if (!contraventionCodes.includes(scenario.contraventionCode)) return false;
  }
  if (authoritySlug !== null && authoritySlug !== scenario.authoritySlug) return false;
  if (noticeTypes !== null) {
    if (scenario.noticeType === null) return false;
    if (!noticeTypes.includes(scenario.noticeType as never)) return false;
  }
  if (proceduralStages !== null) {
    if (scenario.proceduralStage === null) return false;
    if (!proceduralStages.includes(scenario.proceduralStage as never)) return false;
  }
  return true;
}

/**
 * Approved propositions that apply to this case, and nothing else.
 *
 * The granularity requirement, enforced in one place. Approving the code 12
 * definition does not make a statement about code 23 usable, approving a
 * Westminster policy does not carry to Camden, and approving one statutory
 * ground says nothing about the other seven.
 */
export function applicableApproved(
  scenario: PropositionScenario,
  kind?: PropositionKind,
): readonly CandidateProposition[] {
  return CANDIDATE_PROPOSITIONS.filter(
    (candidate) =>
      isApproved(candidate) &&
      applies(candidate.applicability, scenario) &&
      (kind === undefined || candidate.kind === kind),
  );
}

/**
 * Whether this case has an approved statutory ground behind it.
 *
 * The Defence Pack asks this rather than asking whether *any* ground anywhere
 * has been reviewed. One approved ground on one contravention must not turn
 * legal drafting on for every case in the product, which is what a global flag
 * would do the moment the first proposition was signed off.
 */
export function hasApprovedStatutoryGround(scenario: PropositionScenario): boolean {
  return applicableApproved(scenario, 'STATUTORY_GROUND').length > 0;
}

/* ------------------------------------------------------------------ */

export interface BundleProgress {
  readonly total: number;
  readonly byDecision: Record<string, number>;
  readonly awaitingRetrieval: number;
  readonly usable: number;
}

/** What the reviewer worklist reports, and what the tests assert against. */
export function bundleProgress(): BundleProgress {
  const byDecision: Record<string, number> = {};
  for (const candidate of CANDIDATE_PROPOSITIONS) {
    byDecision[candidate.review.decision] = (byDecision[candidate.review.decision] ?? 0) + 1;
  }
  return {
    total: CANDIDATE_PROPOSITIONS.length,
    byDecision,
    awaitingRetrieval: CANDIDATE_PROPOSITIONS.filter(
      (c) => c.source.retrieval === 'NOT_RETRIEVED',
    ).length,
    usable: CANDIDATE_PROPOSITIONS.filter(isApproved).length,
  };
}
