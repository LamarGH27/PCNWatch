import { describe, expect, it } from 'vitest';
import { validateAiResponse, type GroundingContext } from '@/server/ai/validate';
import { fingerprintInput } from '@/server/ai/client';
import { AI_SCHEMAS, PROMPT_VERSIONS } from '@/server/ai/schemas';

const CONTEXT: GroundingContext = {
  permittedReferenceKeys: ['CONTRAVENTION-01', 'GROUND-CONTRAVENTION_DID_NOT_OCCUR'],
  permittedFindingIds: ['finding-a', 'finding-b'],
  verifiedCaseFields: ['pcnNumber', 'incidentDate', 'location'],
  availableEvidenceRefs: ['evidence-1', 'evidence-2'],
};

function validDraft(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'Challenge to PCN CA12345678',
    body: 'I am writing to challenge penalty charge notice CA12345678 issued on 5 January 2026.',
    citedReferenceKeys: ['CONTRAVENTION-01'],
    factualAssertions: [
      {
        assertion: 'The notice was issued on 5 January 2026.',
        supportedBy: 'VERIFIED_CASE_FIELD',
        reference: 'incidentDate',
      },
    ],
    omittedBecauseUnsupported: [],
    ...overrides,
  };
}

describe('schema validation', () => {
  it('rejects output that does not match the schema, with no partial acceptance', () => {
    const result = validateAiResponse('CHALLENGE_DRAFTING', { subject: 'Only a subject' }, CONTEXT);
    expect(result.outcome).toBe('SCHEMA_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('rejects a completely malformed response', () => {
    for (const bad of [null, 'a string', 42, []]) {
      expect(validateAiResponse('CHALLENGE_DRAFTING', bad, CONTEXT).outcome).toBe('SCHEMA_REJECTED');
    }
  });

  it('accepts a well-formed, grounded response', () => {
    const result = validateAiResponse('CHALLENGE_DRAFTING', validDraft(), CONTEXT);
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('has a schema and a prompt version for every job type', () => {
    for (const jobType of Object.keys(AI_SCHEMAS)) {
      expect(PROMPT_VERSIONS[jobType as keyof typeof AI_SCHEMAS]).toBeTruthy();
    }
  });

  it('requires per-field confidence on extraction rather than one overall number', () => {
    const result = validateAiResponse(
      'DOCUMENT_EXTRACTION',
      {
        authorityName: { value: 'Camden', confidence: 0.9, sourceHint: null },
        overallLegibility: 'CLEAR',
      },
      CONTEXT,
    );
    // Missing fields must fail: every field carries its own confidence.
    expect(result.outcome).toBe('SCHEMA_REJECTED');
  });
});

describe('citation grounding', () => {
  it('rejects a citation that does not exist in the approved store', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({ citedReferenceKeys: ['CONTRAVENTION-01', 'CASE-SMITH-V-CAMDEN-2019'] }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('CASE-SMITH-V-CAMDEN-2019');
  });

  it('rejects a real reference that was not offered for this case', () => {
    // GROUND-ALREADY_PAID exists in the store but was not in permittedReferenceKeys.
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({ citedReferenceKeys: ['GROUND-ALREADY_PAID'] }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('not supplied as context');
  });

  it('accepts a draft that cites nothing', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({ citedReferenceKeys: [] }),
      CONTEXT,
    );
    expect(result.outcome).toBe('ACCEPTED');
  });
});

describe('draft groundedness', () => {
  it('rejects an assertion resting on a case field the user has not verified', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        factualAssertions: [
          {
            assertion: 'The amount demanded was £130.',
            supportedBy: 'VERIFIED_CASE_FIELD',
            reference: 'fullAmountPence',
          },
        ],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('has not verified');
  });

  it('rejects a draft relying on evidence that is not attached to the case', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        factualAssertions: [
          {
            assertion: 'The enclosed photograph shows the sign was obscured.',
            supportedBy: 'EVIDENCE_ITEM',
            reference: 'evidence-99',
          },
        ],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('not attached to this case');
  });

  it('allows an assertion drawn from the user’s own account', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        factualAssertions: [
          {
            assertion: 'I was loading goods into the premises at the time.',
            supportedBy: 'USER_NARRATIVE',
            reference: 'narrative',
          },
        ],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('rejects a fabricated case citation in the body', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        body: 'As established in Smith v Camden [2019], the restriction was unenforceable.',
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('case citation');
  });

  it('rejects a statutory section reference invented in the body', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        body: 'Under section 47B of the Road Traffic Regulation Act this notice is invalid.',
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects a guarantee of success', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({ body: 'This challenge is guaranteed to succeed and the PCN will be cancelled.' }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('guarantee');
  });

  it('rejects a numeric probability of success', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({ body: 'On this evidence there is an 82% chance of the appeal succeeding.' }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('does not flag ordinary letter wording', () => {
    const result = validateAiResponse(
      'CHALLENGE_DRAFTING',
      validDraft({
        body:
          'I am writing to challenge this penalty charge notice. I have enclosed photographs ' +
          'taken at the location showing the sign, and a receipt for the parking session. ' +
          'I would be grateful if you would review the notice and cancel it.',
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('ACCEPTED');
  });
});

describe('assessment explanation grounding', () => {
  function explanation(overrides: Record<string, unknown> = {}) {
    return {
      findings: [
        { findingId: 'finding-a', clearerIssue: 'A', clearerWhyItMayMatter: 'Because A.' },
        { findingId: 'finding-b', clearerIssue: 'B', clearerWhyItMayMatter: 'Because B.' },
      ],
      overallExplanation: 'Your case rests on two points.',
      citedReferenceKeys: [],
      ...overrides,
    };
  }

  it('accepts explanations for exactly the findings the engine produced', () => {
    expect(validateAiResponse('ASSESSMENT_EXPLANATION', explanation(), CONTEXT).outcome).toBe(
      'ACCEPTED',
    );
  });

  it('rejects an invented finding', () => {
    const result = validateAiResponse(
      'ASSESSMENT_EXPLANATION',
      explanation({
        findings: [
          { findingId: 'finding-a', clearerIssue: 'A', clearerWhyItMayMatter: 'Because A.' },
          { findingId: 'finding-b', clearerIssue: 'B', clearerWhyItMayMatter: 'Because B.' },
          { findingId: 'finding-invented', clearerIssue: 'C', clearerWhyItMayMatter: 'Because C.' },
        ],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('finding-invented');
  });

  it('rejects a dropped finding', () => {
    const result = validateAiResponse(
      'ASSESSMENT_EXPLANATION',
      explanation({
        findings: [{ findingId: 'finding-a', clearerIssue: 'A', clearerWhyItMayMatter: 'Because A.' }],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    if (result.outcome === 'ACCEPTED') return;
    expect(result.errors.join(' ')).toContain('may not be added or dropped');
  });

  it('rejects a duplicated finding', () => {
    const result = validateAiResponse(
      'ASSESSMENT_EXPLANATION',
      explanation({
        findings: [
          { findingId: 'finding-a', clearerIssue: 'A', clearerWhyItMayMatter: 'Because A.' },
          { findingId: 'finding-a', clearerIssue: 'A again', clearerWhyItMayMatter: 'Because A.' },
        ],
      }),
      CONTEXT,
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });
});

describe('input fingerprinting', () => {
  it('is stable for identical input', () => {
    const a = fingerprintInput('system', [{ type: 'text', text: 'hello' }]);
    const b = fingerprintInput('system', [{ type: 'text', text: 'hello' }]);
    expect(a).toEqual(b);
  });

  it('changes when the input changes', () => {
    const a = fingerprintInput('system', [{ type: 'text', text: 'hello' }]);
    const b = fingerprintInput('system', [{ type: 'text', text: 'goodbye' }]);
    expect(a).not.toEqual(b);
  });

  it('never contains the input itself', () => {
    const secret = 'PCN CA12345678 vehicle AB12 CDE';
    const fingerprint = fingerprintInput('system', [{ type: 'text', text: secret }]);
    expect(fingerprint).not.toContain('CA12345678');
    expect(fingerprint).not.toContain('AB12');
    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('does not hash image bytes into something reversible', () => {
    const fingerprint = fingerprintInput('system', [
      { type: 'image', mediaType: 'image/jpeg', data: 'BASE64IMAGEDATA' },
    ]);
    expect(fingerprint).not.toContain('BASE64IMAGEDATA');
  });
});
