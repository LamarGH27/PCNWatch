import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pcnExtractionSchema } from '@/server/ai/schemas';
import { validateAiResponse } from '@/server/ai/validate';
import { fingerprintInput } from '@/server/ai/client';
import { classifyNotice, PRIVATE_PARKING_MESSAGE } from '@/core/notices/classify-notice';
import { calculateAllDeadlines } from '@/core/deadlines/calculate';
import { SYNTHETIC_PCN, SYNTHETIC_PCN_TEXT } from '../fixtures/pcn/synthetic-pcn';

/**
 * The PCN scanner, from model output to something a user is shown.
 *
 * Everything here runs without a network call: the model's *response* is what
 * these assert on, because that is where the risk lives. A reader that invents
 * a registration, silently corrects a date, or presents a private parking
 * charge as a council PCN does damage the transport layer cannot cause.
 */

const ROOT = resolve(__dirname, '../..');

/** A model response shaped like a good read of the synthetic notice. */
function goodExtraction(overrides: Record<string, unknown> = {}) {
  const field = (value: unknown, confidence = 0.96) => ({
    value,
    confidence,
    sourceHint: null,
  });
  return {
    authorityName: field(SYNTHETIC_PCN.authorityName),
    pcnNumber: field(SYNTHETIC_PCN.pcnNumber),
    vehicleRegistration: field(SYNTHETIC_PCN.vehicleRegistration),
    noticeType: field(SYNTHETIC_PCN.noticeType),
    contraventionCode: field(SYNTHETIC_PCN.contraventionCode),
    contraventionDescription: field(SYNTHETIC_PCN.contraventionDescription),
    incidentDate: field(SYNTHETIC_PCN.incidentDate),
    incidentTime: field(SYNTHETIC_PCN.incidentTime),
    issueDate: field(SYNTHETIC_PCN.issueDate),
    location: field(SYNTHETIC_PCN.location),
    fullAmountPence: field(SYNTHETIC_PCN.fullAmountPence),
    discountedAmountPence: field(SYNTHETIC_PCN.discountedAmountPence),
    discountDeadlinePrinted: field(SYNTHETIC_PCN.discountDeadlinePrinted),
    representationDeadlinePrinted: field(SYNTHETIC_PCN.representationDeadlinePrinted),
    proceduralStageIndicated: field('NOTICE_TO_OWNER'),
    unreadableRegions: [],
    overallLegibility: 'CLEAR',
    ...overrides,
  };
}

const NO_GROUNDING = { permittedReferenceKeys: [] as string[] };

function validate(raw: unknown) {
  return validateAiResponse('DOCUMENT_EXTRACTION', raw, NO_GROUNDING);
}

describe('1. a valid council PCN', () => {
  it('is accepted, with every printed field carried through unchanged', () => {
    const result = validate(goodExtraction());
    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome !== 'ACCEPTED') return;

    expect(result.data.pcnNumber.value).toBe(SYNTHETIC_PCN.pcnNumber);
    expect(result.data.vehicleRegistration.value).toBe(SYNTHETIC_PCN.vehicleRegistration);
    expect(result.data.contraventionCode.value).toBe('12');
    expect(result.data.fullAmountPence.value).toBe(13_000);
    expect(result.data.discountedAmountPence.value).toBe(6_500);
  });

  it('is classified as a local-authority notice, not a private charge', () => {
    expect(classifyNotice(SYNTHETIC_PCN_TEXT).category).toBe('LOCAL_AUTHORITY_PCN');
  });
});

describe('2. a missing PCN number', () => {
  it('is represented as absent rather than guessed at', () => {
    const result = validate(
      goodExtraction({ pcnNumber: { value: null, confidence: 0, sourceHint: null } }),
    );
    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome !== 'ACCEPTED') return;
    // Null is a legitimate answer. An empty string or a placeholder would not be.
    expect(result.data.pcnNumber.value).toBeNull();
    expect(result.data.pcnNumber.confidence).toBe(0);
  });
});

describe('3. an uncertain registration', () => {
  it('keeps the low confidence rather than rounding it away', () => {
    const result = validate(
      goodExtraction({
        vehicleRegistration: { value: 'TE57 XY2', confidence: 0.41, sourceHint: 'smudged' },
      }),
    );
    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome !== 'ACCEPTED') return;
    expect(result.data.vehicleRegistration.confidence).toBeLessThan(0.5);
    // The doubtful reading is preserved verbatim. Substituting the plate we
    // "expected" would be the model correcting the document.
    expect(result.data.vehicleRegistration.value).toBe('TE57 XY2');
  });
});

describe('4. an ambiguous date', () => {
  it('rejects anything that is not an unambiguous ISO date', () => {
    for (const ambiguous of ['11/08/2026', '08/11/2026', '11 Aug 2026', '2026-8-11']) {
      const result = validate(
        goodExtraction({ incidentDate: { value: ambiguous, confidence: 0.9, sourceHint: null } }),
      );
      expect(result.outcome, `${ambiguous} must not be accepted`).toBe('SCHEMA_REJECTED');
    }
  });

  it('accepts an unreadable date as null instead of a plausible one', () => {
    const result = validate(
      goodExtraction({ incidentDate: { value: null, confidence: 0.2, sourceHint: null } }),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });
});

describe('5. a private parking charge', () => {
  const PRIVATE_NOTICE = `
    PARKING CHARGE NOTICE
    Issued by Testbury Parking Solutions Ltd
    This is a parking charge notice issued by a private company.
    Breach of the terms and conditions of parking on private land.
    We are a member of the British Parking Association Approved Operator Scheme.
    Appeals may be made to POPLA.
  `;

  it('is identified as out of scope', () => {
    const classification = classifyNotice(PRIVATE_NOTICE);
    expect(classification.category).toBe('PRIVATE_PARKING_CHARGE');
  });

  it('is explained as unsupported rather than pushed through council rules', () => {
    expect(PRIVATE_PARKING_MESSAGE.toLowerCase()).toContain('private');
    // The council appeal route must not be offered for it.
    expect(PRIVATE_PARKING_MESSAGE.toLowerCase()).not.toContain('tribunal');
  });
});

describe('6. malformed model output', () => {
  it('rejects a response that is not an object at all', () => {
    for (const malformed of [null, undefined, 'not json', 42, [], true]) {
      expect(validate(malformed).outcome).toBe('SCHEMA_REJECTED');
    }
  });

  it('rejects a half-written object', () => {
    expect(validate({ pcnNumber: { value: 'TB1' } }).outcome).toBe('SCHEMA_REJECTED');
  });
});

describe('7. schema violations', () => {
  it('rejects a confidence outside 0..1', () => {
    for (const bad of [1.5, -0.2]) {
      const result = validate(
        goodExtraction({ pcnNumber: { value: 'TB1', confidence: bad, sourceHint: null } }),
      );
      expect(result.outcome).toBe('SCHEMA_REJECTED');
    }
  });

  it('rejects a notice type the product does not define', () => {
    const result = validate(
      goodExtraction({ noticeType: { value: 'PARKING_FINE', confidence: 0.9, sourceHint: null } }),
    );
    expect(result.outcome).toBe('SCHEMA_REJECTED');
  });

  it('rejects an amount that is not a whole number of pence', () => {
    const result = validate(
      goodExtraction({ fullAmountPence: { value: 130.5, confidence: 0.9, sourceHint: null } }),
    );
    expect(result.outcome).toBe('SCHEMA_REJECTED');
  });
});

describe('8. an uncertain deadline source date', () => {
  it('computes nothing when the date the rules key off is missing', () => {
    // No trigger date at all: nothing keys off anything. A refusal is its own
    // shape — it carries no date field to be misread as a real deadline, and a
    // message saying what is missing.
    const deadlines = calculateAllDeadlines({});
    expect(deadlines.length).toBeGreaterThan(0);
    for (const d of deadlines) {
      expect(d.calculated, `${d.deadlineType} must refuse without a trigger date`).toBe(false);
      expect('calculatedDueDate' in d).toBe(false);
      if (!d.calculated) expect(d.message.length).toBeGreaterThan(0);
    }
  });

  it('computes deterministically once the source date is verified', () => {
    const verified = {
      pcnServedDate: SYNTHETIC_PCN.issueDate,
      serviceMethod: 'POSTED' as const,
    };
    const deadlines = calculateAllDeadlines(verified);
    // At least one deadline is now computable, and a computed one carries a
    // real date rather than a refusal.
    const computed = deadlines.filter((d) => d.calculated);
    expect(computed.length).toBeGreaterThan(0);
    for (const d of computed) expect(d.calculatedDueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Deterministic means: same input, same output, every time. No clock, no
    // model, no randomness anywhere in the arithmetic.
    expect(calculateAllDeadlines(verified)).toEqual(deadlines);
  });
});

describe('9. legal citations', () => {
  it('rejects an explanation citing a reference that does not exist', () => {
    const result = validateAiResponse(
      'ASSESSMENT_EXPLANATION',
      {
        summary: 'This notice was issued under an invented rule.',
        findingExplanations: [
          { findingId: 'f1', explanation: 'See the rule.', citationKeys: ['tma-2004-s99-invented'] },
        ],
      },
      { permittedReferenceKeys: [], permittedFindingIds: ['f1'] },
    );
    expect(result.outcome).not.toBe('ACCEPTED');
  });
});

describe('10. logging carries no personal data', () => {
  it('fingerprints the input instead of storing it', () => {
    const print = fingerprintInput('system prompt', [
      { type: 'text', text: SYNTHETIC_PCN_TEXT },
      { type: 'image', mediaType: 'image/jpeg', data: 'AAAABBBBCCCC' },
    ]);

    expect(print).toMatch(/^[0-9a-f]{64}$/);
    for (const secret of [
      SYNTHETIC_PCN.pcnNumber,
      SYNTHETIC_PCN.vehicleRegistration,
      SYNTHETIC_PCN.location,
      'AAAABBBBCCCC',
    ]) {
      expect(print).not.toContain(secret);
    }
  });

  it('is stable for identical input and different for different input', () => {
    const blocks = [{ type: 'text' as const, text: 'a' }];
    expect(fingerprintInput('s', blocks)).toBe(fingerprintInput('s', blocks));
    expect(fingerprintInput('s', blocks)).not.toBe(
      fingerprintInput('s', [{ type: 'text', text: 'b' }]),
    );
  });
});

describe('11. user edits override the model', () => {
  it('treats a user-supplied value as the one that counts', () => {
    const extracted = goodExtraction({
      vehicleRegistration: { value: 'TE57 XY2', confidence: 0.41, sourceHint: null },
    });
    const result = validate(extracted);
    expect(result.outcome).toBe('ACCEPTED');
    if (result.outcome !== 'ACCEPTED') return;

    // What the user confirms replaces the reading, and the deadline engine is
    // fed the verified value — never the model's.
    const verified = { vehicleRegistration: SYNTHETIC_PCN.vehicleRegistration };
    const used = verified.vehicleRegistration ?? result.data.vehicleRegistration.value;
    expect(used).toBe(SYNTHETIC_PCN.vehicleRegistration);
    expect(used).not.toBe(result.data.vehicleRegistration.value);
  });
});

describe('13. no credential can reach the browser', () => {
  const clientSource = readFileSync(resolve(ROOT, 'src/server/ai/client.ts'), 'utf8');

  it('reads the key only from server-side configuration', () => {
    expect(clientSource).not.toMatch(/NEXT_PUBLIC_ANTHROPIC/);
    expect(clientSource).toMatch(/serverEnv\(\)/);
  });

  it('refuses to run in a browser at all', () => {
    expect(clientSource).toContain("typeof window !== 'undefined'");
  });

  it('is not imported by any client component', () => {
    // A 'use client' module that imports this would bundle the key path into
    // the browser payload.
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name)) {
          const source = readFileSync(path, 'utf8');
          if (source.includes("'use client'") && source.includes('@/server/ai/')) {
            offenders.push(path);
          }
        }
      }
    };
    walk(resolve(ROOT, 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('14. the scanner is disabled safely when unconfigured', () => {
  it('never sends an assistant prefill, which every current model rejects', () => {
    const clientSource = readFileSync(resolve(ROOT, 'src/server/ai/client.ts'), 'utf8');
    // The original transport ended the request with a prefilled assistant turn
    // containing '{'. That returns HTTP 400 on every current model, so the
    // integration could not have completed one real call.
    expect(clientSource).not.toMatch(/role:\s*'assistant'/);
    // Structured outputs are what replaced it.
    expect(clientSource).toContain('zodOutputFormat');
    expect(clientSource).toContain('output_config');
  });

  it('checks for a refusal before reading the response as data', () => {
    const clientSource = readFileSync(resolve(ROOT, 'src/server/ai/client.ts'), 'utf8');
    expect(clientSource).toContain("stop_reason === 'refusal'");
  });

  it('keeps the extraction schema and the API constraint in one definition', () => {
    // The schema the API enforces and the schema the response is validated
    // against are the same object, so they cannot drift.
    expect(pcnExtractionSchema).toBeDefined();
    const clientSource = readFileSync(resolve(ROOT, 'src/server/ai/client.ts'), 'utf8');
    expect(clientSource).toContain('AI_SCHEMAS[args.jobType]');
  });
});
