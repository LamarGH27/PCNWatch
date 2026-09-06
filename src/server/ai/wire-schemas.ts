import { z } from 'zod';
import { NARRATIVE_ASSERTION_KINDS, NARRATIVE_STANCES } from '@/core/context/types';
import {
  LEGIBILITY_LEVELS,
  NOTICE_TYPES,
  PROCEDURAL_STAGES,
  type PcnExtraction,
} from './schemas';

/**
 * The shape the model answers in, as opposed to the shape the product uses.
 *
 * These exist because Anthropic's structured outputs cap how many parameters
 * may be unions: at most 16 with `anyOf` or an array `type`. The domain
 * extraction schema had 30. Every `extractedField` contributed two — a
 * nullable `value` and a nullable `sourceHint` — and fourteen fields put it
 * comfortably over. The request was rejected before inference, so the reader
 * never ran at all.
 *
 * The fix is not to make the domain model poorer. It is to stop expressing
 * "we did not find this" as a null union, and express it as a required status
 * instead:
 *
 *     { status: 'FOUND' | 'NOT_PRESENT' | 'UNREADABLE', value, confidence, sourceHint }
 *
 * Every property is required and single-typed, so the whole schema contains
 * zero unions. It is also a better question to ask: a null told us a field was
 * empty but not whether the notice lacked it or the photograph did, and those
 * mean different things to someone deciding whether to challenge.
 *
 * `value` is read *only* when `status` is `FOUND`. In any other state it is
 * ignored entirely and the domain value becomes null, so nothing sitting in
 * that slot can be mistaken for a fact.
 */

export const FIELD_STATUSES = ['FOUND', 'NOT_PRESENT', 'UNREADABLE'] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

/**
 * One extracted fact.
 *
 * `value` carries text in every case — the model writes what it read, exactly
 * as printed. Typed parsing (dates, amounts) happens in the mapper below,
 * deterministically, where a value that does not parse becomes absent rather
 * than a guess.
 */
const wireField = z.object({
  status: z.enum(FIELD_STATUSES),
  /** What is printed on the notice. Meaningful only when status is FOUND. */
  value: z.string().max(400),
  confidence: z.number().min(0).max(1),
  /** Where on the document this was read. Empty string when it cannot be said. */
  sourceHint: z.string().max(200),
});

/**
 * A field whose value comes from a fixed list.
 *
 * The list is offered to the model rather than free text, because picking from
 * nine named notice types is a more answerable question than describing one —
 * and it cannot produce a spelling the mapper then has to reject. `UNKNOWN` is
 * a real member of the domain enum, not a placeholder, so it carries no
 * meaning it should not.
 */
const wireEnumField = <T extends readonly [string, ...string[]]>(values: T) =>
  z.object({
    status: z.enum(FIELD_STATUSES),
    value: z.enum(values),
    confidence: z.number().min(0).max(1),
    sourceHint: z.string().max(200),
  });

export const pcnExtractionWireSchema = z.object({
  authorityName: wireField,
  pcnNumber: wireField,
  vehicleRegistration: wireField,
  noticeType: wireEnumField(NOTICE_TYPES),
  contraventionCode: wireField,
  contraventionDescription: wireField,
  /** ISO date, YYYY-MM-DD. Copied from the notice, never converted or inferred. */
  incidentDate: wireField,
  /** 24-hour time, HH:MM. */
  incidentTime: wireField,
  issueDate: wireField,
  location: wireField,
  /** Whole pence as digits: £130.00 is "13000". */
  fullAmountPence: wireField,
  discountedAmountPence: wireField,
  /** Deadlines PRINTED on the notice. Never a date the model has calculated. */
  discountDeadlinePrinted: wireField,
  representationDeadlinePrinted: wireField,
  proceduralStageIndicated: wireEnumField(PROCEDURAL_STAGES),
  unreadableRegions: z.array(z.string().max(200)).max(10),
  overallLegibility: z.enum(LEGIBILITY_LEVELS),
});

export type PcnExtractionWire = z.infer<typeof pcnExtractionWireSchema>;

/* ------------------------------------------------------------------ */
/* Mapping the wire answer back to the domain model                    */
/* ------------------------------------------------------------------ */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^\d{2}:\d{2}$/;
const DIGITS = /^\d+$/;

interface DomainField<T> {
  value: T | null;
  confidence: number;
  sourceHint: string | null;
}

/**
 * Turns one wire field into one domain field.
 *
 * Two rules, both about not manufacturing facts:
 *
 *  - `value` is read only when the status is FOUND. Anything else is absent,
 *    whatever text happens to be in the slot.
 *  - A FOUND value that does not satisfy `parse` is absent too, and its
 *    confidence drops to zero. The model was confident about something we
 *    rejected; carrying that confidence forward would describe a value the
 *    product does not hold. An absent value always requires verification, so
 *    it can never reach a deadline or a document unchecked.
 */
function toDomainField<T>(
  field: { status: FieldStatus; value: string; confidence: number; sourceHint: string },
  parse: (raw: string) => T | null,
): DomainField<T> {
  const sourceHint = field.sourceHint.trim() === '' ? null : field.sourceHint;

  if (field.status !== 'FOUND') {
    // Confidence is kept: "certainly not printed on this notice" is a useful
    // thing to have said, and a null value is flagged for verification anyway.
    return { value: null, confidence: field.confidence, sourceHint };
  }

  const parsed = parse(field.value);
  if (parsed === null) return { value: null, confidence: 0, sourceHint };
  return { value: parsed, confidence: field.confidence, sourceHint };
}

const asText = (max: number) => (raw: string): string | null => {
  const trimmed = raw.trim();
  return trimmed === '' || trimmed.length > max ? null : trimmed;
};

const asIsoDate = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!ISO_DATE.test(trimmed)) return null;
  // Rejects 2026-02-31 and similar: a well-formed string is not a real date.
  const [y, m, d] = trimmed.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m! - 1 && date.getUTCDate() === d
    ? trimmed
    : null;
};

const asTime = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!HH_MM.test(trimmed)) return null;
  const [h, min] = trimmed.split(':').map(Number);
  return h! < 24 && min! < 60 ? trimmed : null;
};

const asPence = (raw: string): number | null => {
  const trimmed = raw.trim().replace(/[£,\s]/g, '');
  if (!DIGITS.test(trimmed)) return null;
  const pence = Number(trimmed);
  return Number.isSafeInteger(pence) && pence >= 0 && pence <= 1_000_000 ? pence : null;
};

const asMember = <T extends readonly string[]>(members: T) => (raw: string): T[number] | null =>
  (members as readonly string[]).includes(raw) ? (raw as T[number]) : null;

/**
 * Maps the model's answer onto the extraction the rest of PCNWatch uses.
 *
 * Deterministic and total: the same wire response always produces the same
 * domain object, and every branch produces one. The result is then validated
 * against the domain schema exactly as before, so grounding and schema
 * rejection are unchanged.
 */
export function toPcnExtraction(wire: PcnExtractionWire): PcnExtraction {
  return {
    authorityName: toDomainField(wire.authorityName, asText(200)),
    pcnNumber: toDomainField(wire.pcnNumber, asText(64)),
    vehicleRegistration: toDomainField(wire.vehicleRegistration, asText(16)),
    noticeType: toDomainField(wire.noticeType, asMember(NOTICE_TYPES)),
    contraventionCode: toDomainField(wire.contraventionCode, asText(8)),
    contraventionDescription: toDomainField(wire.contraventionDescription, asText(400)),
    incidentDate: toDomainField(wire.incidentDate, asIsoDate),
    incidentTime: toDomainField(wire.incidentTime, asTime),
    issueDate: toDomainField(wire.issueDate, asIsoDate),
    location: toDomainField(wire.location, asText(300)),
    fullAmountPence: toDomainField(wire.fullAmountPence, asPence),
    discountedAmountPence: toDomainField(wire.discountedAmountPence, asPence),
    discountDeadlinePrinted: toDomainField(wire.discountDeadlinePrinted, asIsoDate),
    representationDeadlinePrinted: toDomainField(wire.representationDeadlinePrinted, asIsoDate),
    proceduralStageIndicated: toDomainField(wire.proceduralStageIndicated, asMember(PROCEDURAL_STAGES)),
    unreadableRegions: wire.unreadableRegions,
    overallLegibility: wire.overallLegibility,
  } as PcnExtraction;
}

/* ------------------------------------------------------------------ */
/* Narrative extraction                                                */
/* ------------------------------------------------------------------ */

/**
 * What the model answers with when reading a user's account.
 *
 * Two differences from the domain schema, both deliberate:
 *
 *  - No `source`. The domain type records that every assertion came from the
 *    user's own account; the model is not asked, because a field the model
 *    fills in is a field the model can get wrong, and "where did this fact come
 *    from" is the one thing that must never be wrong here. The mapper stamps it.
 *  - No unions anywhere, so this stays far below the 16-parameter structured
 *    output limit that the document schema had to be rebuilt to satisfy. Every
 *    field is required with an explicit closed set of values.
 */
export const narrativeExtractionWireSchema = z.object({
  assertions: z
    .array(
      z.object({
        kind: z.enum(NARRATIVE_ASSERTION_KINDS),
        stance: z.enum(NARRATIVE_STANCES),
        confidence: z.number().min(0).max(1),
        summary: z.string().max(200),
      }),
    )
    .max(20),
});

export type NarrativeExtractionWire = z.infer<typeof narrativeExtractionWireSchema>;

/**
 * Stamps the provenance the model was never asked for.
 *
 * Also drops an assertion whose summary is empty: a factual claim we cannot
 * show the user is one they cannot confirm, and an assertion nobody confirmed
 * must never reach the assessment — so it is discarded here rather than
 * travelling as something to be filtered out later.
 */
export interface NarrativeExtractionDomain {
  readonly assertions: readonly {
    readonly kind: NarrativeExtractionWire['assertions'][number]['kind'];
    readonly stance: NarrativeExtractionWire['assertions'][number]['stance'];
    readonly confidence: number;
    readonly summary: string;
    readonly source: 'USER_ACCOUNT';
  }[];
}

/**
 * Returns `unknown` deliberately: the mapped shape when the response was the
 * expected one, and the response untouched when it was not. Both go to the
 * validator, which is the only thing that decides whether either is usable.
 */
export function toNarrativeExtraction(wire: NarrativeExtractionWire): unknown {
  /*
   * Passes anything it does not recognise straight through, untouched.
   *
   * The mapper runs before validation, so what it does with a malformed
   * response decides how that response is reported. Coercing one into
   * `{assertions: []}` would be the worst of the options available: the domain
   * schema would accept it and the user would be told, plausibly and wrongly,
   * that we found nothing in their account. Throwing would report a model
   * failure as an outage of ours. Passing it on lets the schema reject it as
   * what it is, which is recorded and visible on the data-health page.
   */
  if (!wire || !Array.isArray(wire.assertions)) return wire;

  return {
    assertions: wire.assertions
      .filter((assertion) => typeof assertion?.summary === 'string' && assertion.summary.trim() !== '')
      .filter((assertion) => summarySupportsKind(assertion.kind, assertion.summary))
      .map((assertion) => ({
        kind: assertion.kind,
        stance: assertion.stance,
        confidence: assertion.confidence,
        summary: assertion.summary.trim(),
        source: 'USER_ACCOUNT' as const,
      })),
  };
}

/**
 * Job types that answer in a wire shape rather than the domain shape.
 *
 * Extraction needs one because of the union limit; narrative extraction needs
 * one because its domain type carries a provenance field the model must not be
 * allowed to set. The remaining jobs need neither.
 */
/**
 * Vocabulary an assertion's own summary must touch to justify its kind.
 *
 * A real assessment told a user "you held a permit" when all they had written
 * was that they paid through RingGo. Nothing derived it — the model chose the
 * kind, and a user confirming a screenful of readings waved it through. The
 * borough's own wording invites the mistake: contravention 12 speaks of "a
 * valid virtual permit", and a paid app session looks like one.
 *
 * So an entitlement is only recorded when the model's own restatement is about
 * an entitlement. Paying to park is not holding a permit, whatever the two have
 * in common.
 *
 * Deliberately narrow. It covers the kinds where one claim is routinely
 * mistaken for another and the vocabulary is unambiguous; everything else is
 * left alone rather than policed by keyword.
 */
const SUMMARY_VOCABULARY: Partial<Record<string, RegExp>> = {
  HELD_PERMIT: /permit|voucher|dispensation|exemption certificate/i,
  PERMIT_VALID: /permit|voucher|dispensation|exemption certificate/i,
  BLUE_BADGE_PRESENT: /blue badge|badge/i,
  PAYMENT_MADE: /paid|pay|payment|ticket|session|tariff/i,
  PAYMENT_BY_APP: /app|ringo|ringgo|paybyphone|justpark|phone|online|session/i,
};

/**
 * Whether an assertion's summary actually supports the kind it was filed under.
 *
 * A mismatch drops that one assertion rather than failing the whole response.
 * That is the proportionate failure: the cost is a claim the user must make
 * again through the questions, which they are asked immediately afterwards —
 * against the cost of PCNWatch telling somebody they held a permit they never
 * mentioned, prioritising permit evidence, and building a case on it.
 */
export function summarySupportsKind(kind: string, summary: string): boolean {
  const required = SUMMARY_VOCABULARY[kind];
  return required ? required.test(summary) : true;
}

export const WIRE_SCHEMAS = {
  DOCUMENT_EXTRACTION: pcnExtractionWireSchema,
  NARRATIVE_EXTRACTION: narrativeExtractionWireSchema,
} as const;

export const WIRE_MAPPERS = {
  DOCUMENT_EXTRACTION: (raw: unknown) => toPcnExtraction(raw as PcnExtractionWire),
  NARRATIVE_EXTRACTION: (raw: unknown) => toNarrativeExtraction(raw as NarrativeExtractionWire),
} as const;
