import type { Jurisdiction, NoticeType, ProceduralStage } from '../types';

/**
 * Candidate legal propositions, and the review they have to survive.
 *
 * The existing `ReferenceRecord` carries a `reviewStatus` of REVIEWED or
 * PENDING_LEGAL_REVIEW and a source name and URL. That is enough to gate a
 * record but not enough to review one: a reviewer opening PCNWatch's reference
 * store cannot see which provision a record came from, whether anybody has ever
 * opened the source, what exactly they would be approving, or what the record
 * must not be read as establishing.
 *
 * So a candidate is a smaller thing than a reference record. It answers one
 * question, names the document and provision it came from, states in as many
 * words what it does *not* establish, and carries a decision that a person
 * makes. Approving one approves that proposition and nothing adjacent to it.
 *
 * Nothing here may be approved by a model. `applicableApproved` requires both a
 * human decision and a record that the source was actually opened, and the
 * second condition exists because the first is a field a script could set.
 */

/** What kind of statement this is. The distinction is the point. */
export const PROPOSITION_KINDS = [
  /** What a contravention code alleges. Not a defence, and not a rule of law. */
  'CONTRAVENTION_DEFINITION',
  /**
   * What a suffix letter denotes within a code.
   *
   * Separated from the definition because approving them together would be one
   * decision covering two documents' worth of detail. "Code 12 alleges parking
   * without a valid permit" and "suffix x denotes an incorrect registration"
   * are checked against different tables and are wrong in different ways.
   */
  'CONTRAVENTION_METADATA',
  /** A ground of representation created by statute. */
  'STATUTORY_GROUND',
  /**
   * What a statutory ground does and does not cover.
   *
   * Deliberately NOT `STATUTORY_GROUND`, and the distinction is a safety
   * boundary rather than a taxonomy preference. `hasApprovedStatutoryGround`
   * keys on that kind, so classifying an interpretation as a ground would mean
   * approving "the already-paid ground means the penalty, not the parking
   * charge" — a proposition whose entire purpose is to NARROW what PCNWatch may
   * say — switching statutory drafting ON. A guard that unlocks the thing it
   * guards is worse than no guard.
   */
  'STATUTORY_GROUND_INTERPRETATION',
  /** What an authority says it will consider. Discretion, never entitlement. */
  'AUTHORITY_POLICY',
  /** How the process runs, and what a notice must contain. */
  'PROCEDURE',
  /** A period, its trigger, and where the arithmetic comes from. */
  'DEADLINE_RULE',
] as const;

export type PropositionKind = (typeof PROPOSITION_KINDS)[number];

export const PROPOSITION_KIND_LABELS: Record<PropositionKind, string> = {
  CONTRAVENTION_DEFINITION: 'What the code alleges',
  CONTRAVENTION_METADATA: 'What a suffix denotes',
  STATUTORY_GROUND: 'Statutory ground',
  STATUTORY_GROUND_INTERPRETATION: 'Scope of a statutory ground (never itself a ground)',
  AUTHORITY_POLICY: 'Authority policy (discretionary)',
  PROCEDURE: 'Procedure',
  DEADLINE_RULE: 'Deadline rule',
};

/**
 * How much weight a source can carry.
 *
 * Ordered. A proposition of law needs primary legislation or the statutory
 * instrument under it; an authority's own policy is authoritative about that
 * authority's practice and about nothing else; the London Councils code list is
 * the framework London authorities actually enforce under, which makes it
 * authoritative for what a code alleges and not for what the law requires.
 *
 * Secondary material is deliberately absent. There is no tier for a blog, a
 * forum, a solicitor's marketing page or a model's recollection, so there is no
 * way to record one as the basis of an approved proposition.
 */
export const SOURCE_TIERS = [
  'PRIMARY_LEGISLATION',
  'STATUTORY_INSTRUMENT',
  'LONDON_COUNCILS_FRAMEWORK',
  'ISSUING_AUTHORITY_POLICY',
  'TRIBUNAL',
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

/** Which kinds of proposition each tier is competent to establish. */
export const TIER_MAY_ESTABLISH: Record<SourceTier, readonly PropositionKind[]> = {
  PRIMARY_LEGISLATION: [
    'STATUTORY_GROUND',
    'STATUTORY_GROUND_INTERPRETATION',
    'PROCEDURE',
    'DEADLINE_RULE',
  ],
  STATUTORY_INSTRUMENT: [
    'STATUTORY_GROUND',
    'STATUTORY_GROUND_INTERPRETATION',
    'PROCEDURE',
    'DEADLINE_RULE',
  ],
  LONDON_COUNCILS_FRAMEWORK: ['CONTRAVENTION_DEFINITION', 'CONTRAVENTION_METADATA'],
  ISSUING_AUTHORITY_POLICY: ['AUTHORITY_POLICY', 'PROCEDURE'],
  // Competent about how the tribunal runs. Never about what the law is.
  TRIBUNAL: ['PROCEDURE', 'DEADLINE_RULE'],
};

/**
 * Whether anybody has actually opened the source.
 *
 * `NOT_RETRIEVED` means the document has been identified — organisation, title,
 * canonical URL, provision — and nobody has read it yet. It is the honest state
 * for a candidate prepared without access to the source, and it is a hard bar
 * to approval: a reviewer marking something REVIEWED is asserting they read it,
 * so a proposition that reaches REVIEWED while still NOT_RETRIEVED is a
 * contradiction the store refuses to act on.
 */
export type SourceRetrieval = 'RETRIEVED' | 'NOT_RETRIEVED';

export interface SourceProvenance {
  readonly organisation: string;
  readonly documentTitle: string;
  /** Something a reviewer can open. Never a search result or a summary of one. */
  readonly canonicalUrl: string;
  readonly jurisdiction: Jurisdiction;
  /** Section, regulation, schedule or paragraph. Null where the whole document is the source. */
  readonly provision: string | null;
  readonly tier: SourceTier;
  /** Publication or in-force date, where the document states one. */
  readonly documentDate: string | null;
  /** When the source was opened. Null while NOT_RETRIEVED. */
  readonly retrievedAt: string | null;
  readonly retrieval: SourceRetrieval;
  /**
   * A short quotation, or a tightly bounded restatement, taken from the source.
   *
   * Null until somebody has read the document. It is never written from a
   * model's recollection: an invented excerpt is the single most dangerous
   * artefact this project could produce, because it would look exactly like
   * evidence that the proposition was checked.
   *
   * Kept short on purpose. Enough for a reviewer to recognise the provision,
   * not a copy of the instrument.
   */
  readonly excerpt: string | null;
}

/** When a proposition applies. Approval is granular because this is. */
export interface Applicability {
  /** Contravention codes, or null for any. */
  readonly contraventionCodes: readonly string[] | null;
  /** Authority slug, or null when the proposition is not authority-specific. */
  readonly authoritySlug: string | null;
  readonly noticeTypes: readonly NoticeType[] | null;
  readonly proceduralStages: readonly ProceduralStage[] | null;
  /** Free-text conditions a reviewer should weigh. Never machine-evaluated. */
  readonly conditions: readonly string[];
}

/**
 * Four outcomes, because two were not enough to review with.
 *
 * REJECTED and NEEDS_CHANGE are both "not approved" to every consumer, and they
 * are different to the person maintaining the bundle: one says the proposition
 * is wrong, the other says it is nearly right. Collapsing them would mean
 * re-deriving that judgement every time somebody picks the work up.
 */
export const REVIEW_DECISIONS = [
  'PENDING_LEGAL_REVIEW',
  'REVIEWED',
  'REJECTED',
  'NEEDS_CHANGE',
] as const;

export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export interface ReviewState {
  readonly decision: ReviewDecision;
  /** Who decided. Null while pending. Never a model, and never "PCNWatch". */
  readonly reviewer: string | null;
  readonly decidedAt: string | null;
  readonly note: string | null;
}

export interface CandidateProposition {
  readonly id: string;
  readonly version: number;
  readonly kind: PropositionKind;
  /**
   * One thing, stated once.
   *
   * Small enough that approving it is a single decision. "Code 12 alleges
   * parking in a residents' bay without a valid permit" and "Westminster says
   * it will consider a genuine mistake" are two propositions, from two
   * documents, with two different weights — and the moment they are one
   * paragraph, approving either approves both.
   */
  readonly proposition: string;
  /** Put to the reviewer as the thing they are actually deciding. */
  readonly reviewQuestion: string;
  /**
   * What this must not be read as establishing.
   *
   * Written for each candidate rather than assumed, because the dangerous
   * inference is always specific: a discretion policy is not an entitlement,
   * and a code definition is not a finding that the contravention occurred.
   */
  readonly doesNotEstablish: readonly string[];
  readonly applicability: Applicability;
  readonly source: SourceProvenance;
  readonly review: ReviewState;
  /** The proposition this replaces, once approved. */
  readonly supersedes: string | null;
  /** Set when a later proposition has replaced this one. */
  readonly supersededBy: string | null;
}

/** A candidate nobody has decided on yet. The only state a model may produce. */
export const UNREVIEWED: ReviewState = {
  decision: 'PENDING_LEGAL_REVIEW',
  reviewer: null,
  decidedAt: null,
  note: null,
};
