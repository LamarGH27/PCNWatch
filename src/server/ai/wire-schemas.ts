import { z } from 'zod';
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

/**
 * Job types that answer in a wire shape rather than the domain shape.
 *
 * Only extraction needs one today. The others are already well under the union
 * limit, and a wire schema they do not need would be indirection for its own
 * sake.
 */
export const WIRE_SCHEMAS = {
  DOCUMENT_EXTRACTION: pcnExtractionWireSchema,
} as const;

export const WIRE_MAPPERS = {
  DOCUMENT_EXTRACTION: (raw: unknown) => toPcnExtraction(raw as PcnExtractionWire),
} as const;
