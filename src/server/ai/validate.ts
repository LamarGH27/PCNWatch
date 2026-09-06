import type { z } from 'zod';
import { unknownCitations } from '@/core/reference/store';
import { AI_SCHEMAS, type AiJobType } from './schemas';

/**
 * The gate every model response passes through before it can be used or stored.
 *
 * Three layers, in order:
 *   1. Schema — the response must parse. No partial acceptance.
 *   2. Citations — every reference key must exist in the approved store. A model
 *      that invents a case, a regulation or an exemption fails here.
 *   3. Groundedness — job-specific checks that the response has not added claims
 *      the deterministic layer did not authorise.
 *
 * A rejection is recorded (see logAiCall) with its reason, so fabrication is
 * visible in the data-health page rather than silently retried away.
 */

export type ValidationOutcome = 'ACCEPTED' | 'SCHEMA_REJECTED' | 'CITATION_REJECTED';

export interface ValidationFailure {
  readonly outcome: Exclude<ValidationOutcome, 'ACCEPTED'>;
  readonly errors: readonly string[];
}

export type ValidationResult<T> =
  | { readonly outcome: 'ACCEPTED'; readonly data: T }
  | ValidationFailure;

export interface GroundingContext {
  /** Reference keys the deterministic layer authorised for this call. */
  readonly permittedReferenceKeys: readonly string[];
  /** Finding ids the assessment engine produced, for explanation jobs. */
  readonly permittedFindingIds?: readonly string[];
  /** Case fields the user has verified, for drafting jobs. */
  readonly verifiedCaseFields?: readonly string[];
  /** Evidence item identifiers available on the case. */
  readonly availableEvidenceRefs?: readonly string[];
}

export function validateAiResponse<K extends AiJobType>(
  jobType: K,
  raw: unknown,
  context: GroundingContext,
): ValidationResult<z.infer<(typeof AI_SCHEMAS)[K]>> {
  const schema = AI_SCHEMAS[jobType];
  const parsed = schema.safeParse(raw);

  if (!parsed.success) {
    return {
      outcome: 'SCHEMA_REJECTED',
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    };
  }

  const data = parsed.data as z.infer<(typeof AI_SCHEMAS)[K]>;
  const errors: string[] = [];

  /* -- Layer 2: citations must exist and must have been offered ------------ */

  const cited = extractCitedKeys(data);
  if (cited.length > 0) {
    const missing = unknownCitations(cited);
    if (missing.length > 0) {
      errors.push(
        `Cited references that do not exist in the approved store: ${missing.join(', ')}.`,
      );
    }

    // Existing but not offered for this call is still a fabricated connection.
    const permitted = new Set(context.permittedReferenceKeys);
    const notOffered = cited.filter((key) => !permitted.has(key) && !missing.includes(key));
    if (notOffered.length > 0) {
      errors.push(
        `Cited references that were not supplied as context for this case: ${notOffered.join(', ')}.`,
      );
    }
  }

  /* -- Layer 3: job-specific groundedness ---------------------------------- */

  if (jobType === 'ASSESSMENT_EXPLANATION') {
    const explanation = data as z.infer<typeof AI_SCHEMAS.ASSESSMENT_EXPLANATION>;
    const permittedIds = new Set(context.permittedFindingIds ?? []);
    const returnedIds = explanation.findings.map((f) => f.findingId);

    const unknownIds = returnedIds.filter((id) => !permittedIds.has(id));
    if (unknownIds.length > 0) {
      errors.push(`Explained findings that the assessment engine did not produce: ${unknownIds.join(', ')}.`);
    }
    if (new Set(returnedIds).size !== returnedIds.length) {
      errors.push('The same finding was explained more than once.');
    }
    if (permittedIds.size > 0 && returnedIds.length !== permittedIds.size) {
      errors.push(
        `Expected explanations for ${permittedIds.size} findings but received ${returnedIds.length}. Findings may not be added or dropped.`,
      );
    }
  }

  if (jobType === 'CHALLENGE_DRAFTING') {
    const draft = data as z.infer<typeof AI_SCHEMAS.CHALLENGE_DRAFTING>;
    const verified = new Set(context.verifiedCaseFields ?? []);
    const evidence = new Set(context.availableEvidenceRefs ?? []);

    for (const assertion of draft.factualAssertions) {
      if (assertion.supportedBy === 'VERIFIED_CASE_FIELD' && !verified.has(assertion.reference)) {
        errors.push(
          `The draft asserts something from case field "${assertion.reference}", which the user has not verified.`,
        );
      }
      if (assertion.supportedBy === 'EVIDENCE_ITEM' && !evidence.has(assertion.reference)) {
        errors.push(
          `The draft relies on evidence "${assertion.reference}", which is not attached to this case.`,
        );
      }
    }

    for (const phrase of FORBIDDEN_DRAFT_PHRASES) {
      if (phrase.pattern.test(draft.body)) {
        errors.push(`The draft contains ${phrase.description}, which PCNWatch must never produce.`);
      }
    }
  }

  if (jobType === 'NARRATIVE_EXTRACTION') {
    const extraction = data as z.infer<typeof AI_SCHEMAS.NARRATIVE_EXTRACTION>;

    /*
     * The account is the one input to this system written by someone who is not
     * our user in the security sense — it is prose typed into a box, and it
     * reaches a model. Two things follow.
     *
     * First, the model must not have turned it into law. The schema already
     * makes a legal *conclusion* unrepresentable — there is no assertion kind
     * for "has a defence" — but `summary` is free text shown back to the user,
     * and free text is where a conclusion would appear if one appeared at all.
     *
     * Second, a summary is quoted into a PCNWatch screen. A response that
     * smuggles a statute, a case or an instruction through that field is
     * rejected outright rather than displayed and relied on.
     */
    for (const assertion of extraction.assertions) {
      for (const phrase of FORBIDDEN_NARRATIVE_PHRASES) {
        if (phrase.pattern.test(assertion.summary)) {
          errors.push(
            `A summary for ${assertion.kind} contains ${phrase.description}. The narrative reader records facts, not conclusions.`,
          );
        }
      }
    }

    // The same claim twice is the model padding, and it would show the user the
    // same sentence to confirm two or three times.
    const kinds = extraction.assertions.map((a) => a.kind);
    const duplicated = kinds.filter(
      (kind, index) => kind !== 'OTHER_REQUIRES_REVIEW' && kinds.indexOf(kind) !== index,
    );
    if (duplicated.length > 0) {
      errors.push(`The same assertion was returned more than once: ${[...new Set(duplicated)].join(', ')}.`);
    }
  }

  if (errors.length > 0) return { outcome: 'CITATION_REJECTED', errors };
  return { outcome: 'ACCEPTED', data };
}

/**
 * Patterns that indicate a draft has strayed into inventing authority.
 *
 * Deliberately narrow: these match the *form* of a fabricated citation, so a
 * legitimate reference supplied through the approved store is unaffected.
 */
/**
 * Legal conclusions, in the one free-text field a narrative assertion has.
 *
 * Narrow on purpose. These match a summary *asserting* something about the law,
 * not one reporting that the user believes it: "says they think the ticket is
 * unlawful" is a faithful record of an account and passes, while "the ticket is
 * unlawful" is PCNWatch stating law it has no business stating and fails.
 */
const FORBIDDEN_NARRATIVE_PHRASES: readonly { pattern: RegExp; description: string }[] = [
  {
    // Unattributed: "is unlawful" with no says/believes/claims before it.
    pattern: /(?<!\b(?:says|said|believes|believed|claims|claimed|thinks|thought|feels|felt|states|stated|asserts|asserted)\b[^.]{0,60})\b(?:is|was|were|are)\s+(?:unlawful|illegal|invalid|void|unenforceable|wrongly\s+issued|improperly\s+issued)\b/i,
    description: 'an unattributed statement that something is unlawful or invalid',
  },
  {
    pattern: /\b(?:has|have|had)\s+(?:a\s+)?(?:valid\s+)?(?:defence|ground|grounds)\b/i,
    description: 'a claim that the user has a defence or grounds',
  },
  {
    pattern: /\b(?:should|ought to|must|can|could)\s+(?:challenge|appeal|contest|dispute|win|succeed)\b/i,
    description: 'a recommendation to challenge or a prediction of success',
  },
  {
    pattern: /\b(?:likely|unlikely|probable|good chance|strong case|weak case)\b/i,
    description: 'a prediction about the outcome',
  },
  {
    pattern: /\b\d{1,3}\s?%|\bpercent\b/i,
    description: 'a percentage, which reads as a probability of success',
  },
  {
    // Statute, regulation or case wording the reference store is the only source of.
    pattern: /\b(?:Traffic Management Act|Road Traffic|Regulation \d+|Schedule \d+|s\.\s?\d+|section \d+)\b/i,
    description: 'a statutory reference',
  },
  {
    pattern: /\b[A-Z][a-z]+\s+v\.?\s+[A-Z][a-z]+\s*[[(]\d{4}[\])]/,
    description: 'what looks like a case citation',
  },
];

const FORBIDDEN_DRAFT_PHRASES: readonly { pattern: RegExp; description: string }[] = [
  {
    // "Smith v Camden [2019]" — a case citation the reference store cannot contain.
    pattern: /\b[A-Z][a-z]+\s+v\.?\s+[A-Z][a-z]+\s*[[(]\d{4}[\])]/,
    description: 'what looks like a case citation',
  },
  {
    pattern: /\bsection\s+\d+[A-Za-z]?\s+of\s+the\s+[A-Z]/,
    description: 'a statutory section reference not drawn from the approved store',
  },
  {
    pattern: /\b(guarantee|guaranteed|will certainly|is certain to)\b.{0,40}\b(succeed|win|cancel)/i,
    description: 'a guarantee of success',
  },
  {
    pattern: /\b\d{1,3}\s*%\s*(chance|likelihood|probability)/i,
    description: 'a numeric probability of success',
  },
];

/** Pulls citation keys out of whichever schema shape the job uses. */
function extractCitedKeys(data: unknown): string[] {
  if (data === null || typeof data !== 'object') return [];
  const record = data as { citedReferenceKeys?: unknown };
  if (!Array.isArray(record.citedReferenceKeys)) return [];
  return record.citedReferenceKeys.filter((k): k is string => typeof k === 'string');
}

/** Test helper: the patterns a draft is checked against. */
export const __forbiddenDraftPhrases = FORBIDDEN_DRAFT_PHRASES;
