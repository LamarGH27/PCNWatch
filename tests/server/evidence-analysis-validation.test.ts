import { describe, expect, it } from 'vitest';
import { validateAiResponse } from '@/server/ai/validate';
import { profileFor } from '@/core/evidence/profiles';

/**
 * The gate an evidence reading passes before it can be stored.
 *
 * The schema stops the reader labelling something a judgement — there is no
 * field for one. What the schema cannot stop is a judgement written into a
 * value, and a value is quoted onto the confirmation screen, where ticking it
 * would have the user vouch for our opinion as their document's content.
 */

const PERMIT_FIELDS = profileFor('PERMIT')!.fields;

const grounding = (fields: readonly string[] = PERMIT_FIELDS) => ({
  permittedReferenceKeys: [],
  permittedEvidenceFields: fields,
});

function response(observations: unknown[], legibility = 'CLEAR') {
  return { legibility, observations, unreadableRegions: [] };
}

describe('validating an evidence reading', () => {
  it('accepts a plain transcription', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([
        { field: 'PERMIT_TYPE', value: 'Resident permit, Zone CA-H', confidence: 0.9, status: 'READ' },
        { field: 'VALID_TO', value: '2026-03-31', confidence: 0.88, status: 'READ' },
      ]),
      grounding(),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('rejects a field this kind of document was not authorised to carry', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([
        { field: 'SIGN_RESTRICTION_TEXT', value: 'No waiting at any time', confidence: 0.9, status: 'READ' },
      ]),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
    expect(result.outcome !== 'ACCEPTED' && result.errors.join(' ')).toContain(
      'SIGN_RESTRICTION_TEXT',
    );
  });

  it('rejects a conclusion written into a reading', () => {
    for (const value of [
      'This permit was valid on the date in question',
      'The session covers the time of the contravention',
      'No contravention occurred',
      'The PCN is invalid',
    ]) {
      const result = validateAiResponse(
        'EVIDENCE_ANALYSIS',
        response([{ field: 'PERMIT_TYPE', value, confidence: 0.95, status: 'READ' }]),
        grounding(),
      );
      expect(result.outcome, `"${value}" was accepted as a transcription`).toBe(
        'CITATION_REJECTED',
      );
    }
  });

  it('still accepts a sign that genuinely says something absolute', () => {
    // The patterns need the document as the subject, so real signage passes.
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([
        {
          field: 'SIGN_RESTRICTION_TEXT',
          value: 'PERMIT HOLDERS ONLY. VALID PERMIT MUST BE DISPLAYED AT ALL TIMES',
          confidence: 0.92,
          status: 'READ',
        },
      ]),
      grounding(profileFor('PARKING_SIGN')!.fields),
    );
    expect(result.outcome).toBe('ACCEPTED');
  });

  it('rejects an invented statute or case in a reading', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([
        {
          field: 'PERMIT_TYPE',
          value: 'Exemption under section 6 of the Traffic Order',
          confidence: 0.9,
          status: 'READ',
        },
      ]),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects an unreadable document that also returned readings', () => {
    /*
     * The combination that does damage: flagged illegible, so it never improves
     * the basis, while the confirmation screen offers a page of values to tick.
     * Whichever half is wrong, it is not usable.
     */
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response(
        [{ field: 'VALID_TO', value: '2026-03-31', confidence: 0.99, status: 'READ' }],
        'UNREADABLE',
      ),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects the same field read twice', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([
        { field: 'VALID_TO', value: '2026-03-31', confidence: 0.9, status: 'READ' },
        { field: 'VALID_TO', value: '2026-04-30', confidence: 0.8, status: 'READ' },
      ]),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects a reading reported as read but empty', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      response([{ field: 'VALID_TO', value: '   ', confidence: 0.9, status: 'READ' }]),
      grounding(),
    );
    expect(result.outcome).toBe('CITATION_REJECTED');
  });

  it('rejects a response that does not fit the schema at all', () => {
    const result = validateAiResponse(
      'EVIDENCE_ANALYSIS',
      { legibility: 'BLURRY', observations: [] },
      grounding(),
    );
    expect(result.outcome).toBe('SCHEMA_REJECTED');
  });
});
