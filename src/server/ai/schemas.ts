import { z } from 'zod';
import {
  NARRATIVE_ASSERTION_KINDS,
  NARRATIVE_STANCES,
} from '@/core/context/types';

/**
 * Structured output schemas for every AI job.
 *
 * A model response that does not parse against its schema is never persisted as
 * accepted output. There is no "best effort" path and no partial acceptance:
 * either the response matches the contract or the job fails and the user is told.
 *
 * Note the shape of the confidence fields. Every extracted value carries its own
 * confidence so the UI can require verification field by field, rather than
 * accepting a document wholesale on one overall number.
 */

const confidence = z.number().min(0).max(1);

const extractedField = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    value: inner.nullable(),
    confidence,
    /** Where on the document the model believes it read this, if it can say. */
    sourceHint: z.string().max(200).nullable().default(null),
  });

/* ------------------------------------------------------------------ */
/* 1. Document extraction                                              */
/* ------------------------------------------------------------------ */

/**
 * Notice types and procedural stages, named once.
 *
 * The wire schema the model answers against and the domain schema its answer
 * is validated against both build from these, so a member added to one cannot
 * silently be missing from the other.
 */
export const NOTICE_TYPES = [
  'PCN_ON_STREET',
  'PCN_POSTAL',
  'NOTICE_TO_OWNER',
  'NOTICE_OF_REJECTION',
  'NOTICE_OF_ACCEPTANCE',
  'CHARGE_CERTIFICATE',
  'ORDER_FOR_RECOVERY',
  'PRIVATE_PARKING_CHARGE',
  'UNKNOWN',
] as const;

export const PROCEDURAL_STAGES = [
  'NEW',
  'INFORMAL_CHALLENGE',
  'NOTICE_TO_OWNER',
  'FORMAL_REPRESENTATION',
  'NOTICE_OF_ACCEPTANCE',
  'NOTICE_OF_REJECTION',
  'TRIBUNAL_ELIGIBLE',
  'CLOSED_PAID',
  'UNKNOWN_STAGE',
] as const;

export const LEGIBILITY_LEVELS = ['CLEAR', 'PARTIAL', 'POOR'] as const;

export const pcnExtractionSchema = z.object({
  authorityName: extractedField(z.string().max(200)),
  pcnNumber: extractedField(z.string().max(64)),
  vehicleRegistration: extractedField(z.string().max(16)),
  noticeType: extractedField(z.enum(NOTICE_TYPES)),
  contraventionCode: extractedField(z.string().max(8)),
  contraventionDescription: extractedField(z.string().max(400)),
  incidentDate: extractedField(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  incidentTime: extractedField(z.string().regex(/^\d{2}:\d{2}$/)),
  issueDate: extractedField(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  location: extractedField(z.string().max(300)),
  fullAmountPence: extractedField(z.number().int().min(0).max(1_000_000)),
  discountedAmountPence: extractedField(z.number().int().min(0).max(1_000_000)),
  /** Dates printed on the notice. Never a date the model has calculated. */
  discountDeadlinePrinted: extractedField(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  representationDeadlinePrinted: extractedField(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  /**
   * What the document says about where in the process it sits. The state machine
   * decides whether to act on this; the model does not set the stage itself.
   */
  proceduralStageIndicated: extractedField(z.enum(PROCEDURAL_STAGES)),
  /** Free text the model could not attribute to a field. Helps a human debug. */
  unreadableRegions: z.array(z.string().max(200)).max(10).default([]),
  overallLegibility: z.enum(LEGIBILITY_LEVELS),
});

export type PcnExtraction = z.infer<typeof pcnExtractionSchema>;

/* ------------------------------------------------------------------ */
/* 2. Document classification                                          */
/* ------------------------------------------------------------------ */

export const documentClassificationSchema = z.object({
  category: z.enum(['LOCAL_AUTHORITY_PCN', 'PRIVATE_PARKING_CHARGE', 'OTHER', 'UNKNOWN']),
  noticeType: z.string().max(64),
  confidence,
  /** Phrases on the document that support the classification. */
  supportingPhrases: z.array(z.string().max(200)).max(8),
  reasoning: z.string().max(600),
});

/* ------------------------------------------------------------------ */
/* 3. Case summarisation                                               */
/* ------------------------------------------------------------------ */

export const caseSummarySchema = z.object({
  summary: z.string().max(1200),
  nextAction: z.string().max(300),
  openQuestions: z.array(z.string().max(200)).max(6),
});

/* ------------------------------------------------------------------ */
/* 4. Assessment explanation                                           */
/* ------------------------------------------------------------------ */

/**
 * The model rewrites the wording of findings the rules engine produced. It may
 * not add, remove or re-rank one: `findingId` must match an existing finding and
 * the count must match exactly (enforced in validate.ts).
 */
export const assessmentExplanationSchema = z.object({
  findings: z
    .array(
      z.object({
        findingId: z.string().max(120),
        clearerIssue: z.string().max(400),
        clearerWhyItMayMatter: z.string().max(900),
      }),
    )
    .max(30),
  overallExplanation: z.string().max(1200),
  citedReferenceKeys: z.array(z.string().max(120)).max(30).default([]),
});

/* ------------------------------------------------------------------ */
/* 5. Challenge drafting                                               */
/* ------------------------------------------------------------------ */

export const challengeDraftSchema = z.object({
  subject: z.string().max(200),
  body: z.string().max(12_000),
  /**
   * Every reference the draft relies on. Validated against the approved store;
   * a key that does not exist rejects the whole output.
   */
  citedReferenceKeys: z.array(z.string().max(120)).max(30),
  /**
   * Factual assertions the draft makes about the user's case. Each must map to a
   * verified case field or an uploaded evidence item, so an unsupported claim can
   * be detected rather than read past.
   */
  factualAssertions: z
    .array(
      z.object({
        assertion: z.string().max(400),
        supportedBy: z.enum(['VERIFIED_CASE_FIELD', 'USER_NARRATIVE', 'EVIDENCE_ITEM']),
        reference: z.string().max(200),
      }),
    )
    .max(40),
  omittedBecauseUnsupported: z.array(z.string().max(300)).max(10).default([]),
});

export type ChallengeDraft = z.infer<typeof challengeDraftSchema>;

/* ------------------------------------------------------------------ */
/* 6. Council response comparison                                      */
/* ------------------------------------------------------------------ */

export const responseComparisonSchema = z.object({
  rejectionReasons: z
    .array(
      z.object({
        reason: z.string().max(500),
        addressesSubmittedPoint: z.boolean(),
        submittedPointReference: z.string().max(200).nullable(),
      }),
    )
    .max(20),
  submittedPointsNotAddressed: z.array(z.string().max(400)).max(20),
  evidenceNotAcknowledged: z.array(z.string().max(200)).max(20),
  /** Narrative only. The deadline itself is always computed deterministically. */
  proceduralPositionSummary: z.string().max(900),
  citedReferenceKeys: z.array(z.string().max(120)).max(20).default([]),
});

/* ------------------------------------------------------------------ */
/* 7. Narrative extraction                                             */
/* ------------------------------------------------------------------ */

/*
 * The vocabulary lives in src/core/context/types.ts, because the browser renders
 * these back to the user for confirmation and the server constrains the model to
 * them. One list, so a kind cannot exist on one side and not the other.
 */

export const narrativeExtractionSchema = z.object({
  assertions: z
    .array(
      z.object({
        kind: z.enum(NARRATIVE_ASSERTION_KINDS),
        stance: z.enum(NARRATIVE_STANCES),
        confidence,
        /**
         * A short neutral restatement, shown to the user for confirmation.
         *
         * Attributed, never asserted: "says a resident permit was held", not
         * "a resident permit was held". The difference is the whole safety
         * boundary of this feature rendered as a sentence.
         */
        summary: z.string().max(200),
        /**
         * Fixed. The model does not get to say where a fact came from — every
         * assertion here came from the user's own account and nothing else, and
         * the mapper sets this rather than trusting the response.
         */
        source: z.literal('USER_ACCOUNT'),
      }),
    )
    .max(20),
});

/* ------------------------------------------------------------------ */

export const AI_SCHEMAS = {
  DOCUMENT_EXTRACTION: pcnExtractionSchema,
  DOCUMENT_CLASSIFICATION: documentClassificationSchema,
  CASE_SUMMARISATION: caseSummarySchema,
  ASSESSMENT_EXPLANATION: assessmentExplanationSchema,
  CHALLENGE_DRAFTING: challengeDraftSchema,
  RESPONSE_COMPARISON: responseComparisonSchema,
  NARRATIVE_EXTRACTION: narrativeExtractionSchema,
} as const;

export type AiJobType = keyof typeof AI_SCHEMAS;

/** Prompt template versions. Persisted with every call so output is reproducible. */
export const PROMPT_VERSIONS: Record<AiJobType, string> = {
  // v2: the model answers with an explicit per-field status rather than a
  // nullable value. Stored with every call, so output from before and after the
  // change is never compared as though it came from the same contract.
  DOCUMENT_EXTRACTION: 'extract-v2',
  DOCUMENT_CLASSIFICATION: 'classify-v1',
  CASE_SUMMARISATION: 'summarise-v1',
  ASSESSMENT_EXPLANATION: 'explain-v1',
  CHALLENGE_DRAFTING: 'draft-v1',
  RESPONSE_COMPARISON: 'compare-v1',
  NARRATIVE_EXTRACTION: 'narrative-v1',
};
