import { classifyNotice, PRIVATE_PARKING_MESSAGE } from '@/core/notices/classify-notice';
import { normaliseContraventionCode, contraventionSuffix } from '@/core/reference/store';
import { runAiJob } from '@/server/ai/client';
import { EXTRACTION_SYSTEM } from '@/server/ai/prompts';
import type { PcnExtraction } from '@/server/ai/schemas';
import type { NoticeType } from '@/core/reference/types';

/**
 * Turns an uploaded notice into structured, verifiable fields.
 *
 * The important design decision here: extraction output is a *proposal*, never a
 * fact. Every field arrives with its own confidence, low-confidence fields are
 * marked as requiring verification, and nothing drives a deadline or a document
 * until the user has confirmed it.
 *
 * Scope is decided deterministically. If the document is a private parking charge,
 * we say so and stop, rather than pushing it through local-authority rules.
 */

/** Below this a field must be confirmed by the user before it is used. */
export const FIELD_VERIFICATION_THRESHOLD = 0.85;

/** Fields that always require confirmation, however confident the model is. */
export const ALWAYS_VERIFY: readonly string[] = [
  'pcnNumber',
  'contraventionCode',
  'incidentDate',
  'issueDate',
  'fullAmountPence',
];

export interface ExtractedFieldView {
  readonly key: string;
  readonly label: string;
  readonly value: string | number | null;
  readonly confidence: number;
  readonly requiresVerification: boolean;
  readonly hint: string | null;
}

export type ExtractionOutcome =
  | {
      readonly kind: 'EXTRACTED';
      readonly fields: readonly ExtractedFieldView[];
      readonly noticeType: NoticeType;
      readonly legibility: 'CLEAR' | 'PARTIAL' | 'POOR';
      readonly unreadableRegions: readonly string[];
      readonly aiLogId: string | null;
    }
  | {
      readonly kind: 'OUT_OF_SCOPE';
      readonly message: string;
      readonly explanation: string;
    }
  | {
      readonly kind: 'FAILED';
      readonly what: string;
      readonly whatYouCanDo: string;
      readonly dataSaved: boolean;
    };

export interface ExtractionInput {
  /** Base64 document content. */
  readonly data: string;
  readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
  /** Text already extracted from the document, when available, for classification. */
  readonly extractedText?: string;
  readonly userId?: string;
  readonly caseId?: string;
}

const FIELD_LABELS: Record<string, string> = {
  authorityName: 'Issuing authority',
  pcnNumber: 'PCN number',
  vehicleRegistration: 'Vehicle registration',
  contraventionCode: 'Contravention code',
  contraventionDescription: 'Contravention description',
  incidentDate: 'Date of the alleged contravention',
  incidentTime: 'Time',
  issueDate: 'Date the notice was issued',
  location: 'Location',
  fullAmountPence: 'Full amount',
  discountedAmountPence: 'Discounted amount',
  discountDeadlinePrinted: 'Discount deadline printed on the notice',
  representationDeadlinePrinted: 'Representation deadline printed on the notice',
};

export async function extractNotice(input: ExtractionInput): Promise<ExtractionOutcome> {
  // Deterministic scope check first, on any text we already have. This runs
  // before the model so an out-of-scope notice never reaches it at all.
  if (input.extractedText) {
    const classification = classifyNotice(input.extractedText);
    if (classification.category === 'PRIVATE_PARKING_CHARGE') {
      return {
        kind: 'OUT_OF_SCOPE',
        message: PRIVATE_PARKING_MESSAGE,
        explanation: classification.explanation,
      };
    }
  }

  const result = await runAiJob({
    jobType: 'DOCUMENT_EXTRACTION',
    system: EXTRACTION_SYSTEM,
    userContent: [
      { type: 'text', text: 'Read this notice and return the fields printed on it.' },
      input.mediaType === 'application/pdf'
        ? { type: 'document', mediaType: 'application/pdf', data: input.data }
        : { type: 'image', mediaType: input.mediaType, data: input.data },
    ],
    // Extraction cites nothing, so nothing is permitted.
    grounding: { permittedReferenceKeys: [] },
    userId: input.userId,
    caseId: input.caseId,
  });

  if (!result.ok || !result.data) {
    return {
      kind: 'FAILED',
      what:
        result.outcome === 'SCHEMA_REJECTED'
          ? 'We read the notice but could not make sense of the result reliably enough to use it.'
          : 'We could not read the notice automatically.',
      whatYouCanDo:
        'Nothing has been saved. You can enter the details from your notice by hand — everything else works exactly the same.',
      dataSaved: false,
    };
  }

  const extraction = result.data as PcnExtraction;

  // The model's own read of the notice type is a second scope check.
  if (extraction.noticeType.value === 'PRIVATE_PARKING_CHARGE') {
    return {
      kind: 'OUT_OF_SCOPE',
      message: PRIVATE_PARKING_MESSAGE,
      explanation:
        'The notice appears to have been issued by a private parking operator rather than a local authority.',
    };
  }

  return {
    kind: 'EXTRACTED',
    fields: toFieldViews(extraction),
    noticeType: (extraction.noticeType.value ?? 'UNKNOWN') as NoticeType,
    legibility: extraction.overallLegibility,
    unreadableRegions: extraction.unreadableRegions,
    aiLogId: result.logId,
  };
}

/**
 * Flattens extraction output into a verification list.
 *
 * A field is flagged for verification when its confidence is low OR when it is
 * one that drives a deadline or a document — those are checked regardless,
 * because a confidently misread date is worse than an obviously unreadable one.
 */
export function toFieldViews(extraction: PcnExtraction): ExtractedFieldView[] {
  const views: ExtractedFieldView[] = [];

  for (const [key, label] of Object.entries(FIELD_LABELS)) {
    const field = (extraction as unknown as Record<string, { value: unknown; confidence: number; sourceHint: string | null } | undefined>)[key];
    if (!field) continue;

    const value =
      typeof field.value === 'string' || typeof field.value === 'number' ? field.value : null;

    views.push({
      key,
      label,
      value,
      confidence: field.confidence,
      requiresVerification:
        value === null ||
        field.confidence < FIELD_VERIFICATION_THRESHOLD ||
        ALWAYS_VERIFY.includes(key),
      hint: field.sourceHint,
    });
  }

  return views;
}

/**
 * Normalises a verified contravention code into its canonical form plus suffix.
 * Called after the user confirms the value, never before.
 */
export function normaliseVerifiedCode(raw: string | null): {
  code: string | null;
  suffix: string | null;
} {
  if (!raw) return { code: null, suffix: null };
  const code = normaliseContraventionCode(raw);
  return { code: /^\d{2}$/.test(code) ? code : null, suffix: contraventionSuffix(raw) };
}

/**
 * Parses an amount the user has confirmed, in pounds or pence, into pence.
 * Returns null for anything ambiguous rather than picking an interpretation.
 */
export function parseAmountToPence(raw: string): number | null {
  const cleaned = raw.trim().replace(/^£/, '').replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const pounds = Number(cleaned);
  if (!Number.isFinite(pounds) || pounds < 0 || pounds > 10_000) return null;
  return Math.round(pounds * 100);
}
