import { describe, expect, it } from 'vitest';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { AI_SCHEMAS, type AiJobType } from '@/server/ai/schemas';
import {
  WIRE_SCHEMAS,
  toPcnExtraction,
  type PcnExtractionWire,
} from '@/server/ai/wire-schemas';

/**
 * What actually gets sent to Anthropic, and what comes back.
 *
 * The first real call never reached inference: Anthropic rejected the schema
 * outright with "Schemas contains too many parameters with union types (30
 * parameters with type arrays or anyOf; limit 16)". Every `extractedField`
 * contributed two unions — a nullable `value` and a nullable `sourceHint` — and
 * fourteen fields put it comfortably over.
 *
 * The limit is a property of the JSON Schema the SDK generates, not of the Zod
 * source, so it is checked on the generated schema. Nothing else would have
 * caught it.
 */

/** Anthropic counts a parameter as a union when it has anyOf/oneOf or an array `type`. */
function unionParameters(node: unknown, path = '$', found: string[] = []): string[] {
  if (!node || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    node.forEach((child, i) => unionParameters(child, `${path}[${i}]`, found));
    return found;
  }
  const record = node as Record<string, unknown>;
  if (
    Array.isArray(record.anyOf) ||
    Array.isArray(record.oneOf) ||
    Array.isArray(record.type)
  ) {
    found.push(path);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === 'anyOf' || key === 'oneOf') continue;
    unionParameters(value, `${path}.${key}`, found);
  }
  return found;
}

/** The schema actually sent for a job: the wire one where it exists. */
function schemaSentFor(jobType: AiJobType) {
  const wire = WIRE_SCHEMAS[jobType as keyof typeof WIRE_SCHEMAS];
  return zodOutputFormat(wire ?? AI_SCHEMAS[jobType]).schema;
}

/** Anthropic's documented ceiling, and the number the failed request reported. */
const UNION_LIMIT = 16;

describe('the schema sent to Anthropic stays within the union limit', () => {
  const jobTypes = Object.keys(AI_SCHEMAS) as AiJobType[];

  it.each(jobTypes)('%s is under the limit', (jobType) => {
    const unions = unionParameters(schemaSentFor(jobType));
    expect(
      unions.length,
      `${jobType} sends ${unions.length} union parameters (limit ${UNION_LIMIT}): ${unions
        .slice(0, 8)
        .join(', ')}`,
    ).toBeLessThanOrEqual(UNION_LIMIT);
  });

  it('sends no unions at all for extraction, the one that failed', () => {
    expect(unionParameters(schemaSentFor('DOCUMENT_EXTRACTION'))).toEqual([]);
  });

  it('would still catch the original fault', () => {
    // The domain schema is unchanged and still over the limit. If someone
    // sends it directly again, this is the number they would get.
    const domain = unionParameters(zodOutputFormat(AI_SCHEMAS.DOCUMENT_EXTRACTION).schema);
    expect(domain.length).toBeGreaterThan(UNION_LIMIT);
  });

  it('requires every wire property, so nothing is optional-by-omission', () => {
    const schema = schemaSentFor('DOCUMENT_EXTRACTION') as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
  });
});

/* ------------------------------------------------------------------ */

function wireField(over: Partial<PcnExtractionWire['pcnNumber']> = {}) {
  return { status: 'FOUND' as const, value: 'x', confidence: 0.9, sourceHint: '', ...over };
}

function wire(over: Partial<PcnExtractionWire> = {}): PcnExtractionWire {
  return {
    authorityName: wireField({ value: 'London Borough of Testbury' }),
    pcnNumber: wireField({ value: 'TB99887766' }),
    vehicleRegistration: wireField({ value: 'TE57 XYZ' }),
    noticeType: { status: 'FOUND', value: 'PCN_POSTAL', confidence: 0.95, sourceHint: 'header' },
    contraventionCode: wireField({ value: '12' }),
    contraventionDescription: wireField({ value: "Parked in a residents' bay" }),
    incidentDate: wireField({ value: '2026-08-11' }),
    incidentTime: wireField({ value: '14:35' }),
    issueDate: wireField({ value: '2026-08-14' }),
    location: wireField({ value: 'EVERSHOLT STREET NW1' }),
    fullAmountPence: wireField({ value: '13000' }),
    discountedAmountPence: wireField({ value: '6500' }),
    discountDeadlinePrinted: wireField({ value: '2026-08-28' }),
    representationDeadlinePrinted: wireField({ value: '2026-09-11' }),
    proceduralStageIndicated: {
      status: 'FOUND',
      value: 'NOTICE_TO_OWNER',
      confidence: 0.8,
      sourceHint: '',
    },
    unreadableRegions: [],
    overallLegibility: 'CLEAR',
    ...over,
  };
}

describe('mapping the model answer back to the domain model', () => {
  it('carries every found value through unchanged', () => {
    const domain = toPcnExtraction(wire());
    expect(domain.pcnNumber.value).toBe('TB99887766');
    expect(domain.vehicleRegistration.value).toBe('TE57 XYZ');
    expect(domain.noticeType.value).toBe('PCN_POSTAL');
    expect(domain.incidentDate.value).toBe('2026-08-11');
    expect(domain.incidentTime.value).toBe('14:35');
    expect(domain.fullAmountPence.value).toBe(13_000);
    expect(domain.discountedAmountPence.value).toBe(6_500);
    expect(domain.proceduralStageIndicated.value).toBe('NOTICE_TO_OWNER');
  });

  it('keeps confidence and source hints', () => {
    const domain = toPcnExtraction(wire());
    expect(domain.pcnNumber.confidence).toBe(0.9);
    expect(domain.noticeType.sourceHint).toBe('header');
    // An empty hint is absent, not the empty string.
    expect(domain.pcnNumber.sourceHint).toBeNull();
  });

  it('distinguishes a field the notice lacks from one that cannot be read', () => {
    const absent = toPcnExtraction(
      wire({ discountDeadlinePrinted: wireField({ status: 'NOT_PRESENT', value: '', confidence: 0.97 }) }),
    );
    const unreadable = toPcnExtraction(
      wire({ pcnNumber: wireField({ status: 'UNREADABLE', value: '', confidence: 0.1 }) }),
    );

    expect(absent.discountDeadlinePrinted.value).toBeNull();
    expect(unreadable.pcnNumber.value).toBeNull();
    // Both are absent to the product, and both keep what the model said about
    // how sure it was — the distinction survives in the confidence.
    expect(absent.discountDeadlinePrinted.confidence).toBe(0.97);
    expect(unreadable.pcnNumber.confidence).toBe(0.1);
  });

  it('ignores whatever sits in value when the status is not FOUND', () => {
    // The critical guarantee: no text in a non-FOUND slot can become a fact.
    const domain = toPcnExtraction(
      wire({
        pcnNumber: wireField({ status: 'NOT_PRESENT', value: 'TB00000000' }),
        incidentDate: wireField({ status: 'UNREADABLE', value: '2026-01-01' }),
        fullAmountPence: wireField({ status: 'NOT_PRESENT', value: '9900' }),
      }),
    );
    expect(domain.pcnNumber.value).toBeNull();
    expect(domain.incidentDate.value).toBeNull();
    expect(domain.fullAmountPence.value).toBeNull();
  });

  it('refuses a malformed date rather than repairing it', () => {
    for (const bad of ['11/08/2026', '2026-8-11', '2026-02-31', 'August 11 2026', '']) {
      const domain = toPcnExtraction(wire({ incidentDate: wireField({ value: bad }) }));
      expect(domain.incidentDate.value, `${bad} must not be accepted`).toBeNull();
      // Confidence is dropped: the model was sure about something we rejected.
      expect(domain.incidentDate.confidence).toBe(0);
    }
  });

  it('refuses a malformed time', () => {
    for (const bad of ['2:35pm', '25:00', '14:99', '1435']) {
      expect(toPcnExtraction(wire({ incidentTime: wireField({ value: bad }) })).incidentTime.value)
        .toBeNull();
    }
  });

  it('reads amounts as whole pence and refuses anything else', () => {
    expect(toPcnExtraction(wire({ fullAmountPence: wireField({ value: '13000' }) })).fullAmountPence.value)
      .toBe(13_000);
    // Tolerant of a currency symbol, because a model will sometimes include one.
    expect(toPcnExtraction(wire({ fullAmountPence: wireField({ value: '£13000' }) })).fullAmountPence.value)
      .toBe(13_000);
    for (const bad of ['130.00', 'one hundred', '-500', '']) {
      expect(
        toPcnExtraction(wire({ fullAmountPence: wireField({ value: bad }) })).fullAmountPence.value,
        `${bad} must not be read as an amount`,
      ).toBeNull();
    }
  });

  it('is deterministic', () => {
    const input = wire();
    expect(toPcnExtraction(input)).toEqual(toPcnExtraction(input));
  });

  it('passes the domain schema it is mapped into', () => {
    const parsed = AI_SCHEMAS.DOCUMENT_EXTRACTION.safeParse(toPcnExtraction(wire()));
    expect(parsed.success).toBe(true);
  });

  it('still passes the domain schema when everything is absent', () => {
    const empty = Object.fromEntries(
      Object.keys(wire())
        .filter((k) => k !== 'unreadableRegions' && k !== 'overallLegibility')
        .map((k) => [k, wireField({ status: 'NOT_PRESENT', value: '' })]),
    ) as unknown as PcnExtractionWire;
    const parsed = AI_SCHEMAS.DOCUMENT_EXTRACTION.safeParse(
      toPcnExtraction({
        ...empty,
        noticeType: { status: 'NOT_PRESENT', value: 'UNKNOWN', confidence: 0.2, sourceHint: '' },
        proceduralStageIndicated: {
          status: 'NOT_PRESENT',
          value: 'UNKNOWN_STAGE',
          confidence: 0.2,
          sourceHint: '',
        },
        unreadableRegions: ['whole page'],
        overallLegibility: 'POOR',
      }),
    );
    expect(parsed.success).toBe(true);
  });
});
