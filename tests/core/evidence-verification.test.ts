import { describe, expect, it } from 'vitest';
import { EVIDENCE_FIELDS, confirmableObservations } from '@/core/evidence/analysis';
import type { EvidenceAnalysis } from '@/core/evidence/analysis';
import { EVIDENCE_ANALYSIS_PROFILES, isAnalysable, profileFor } from '@/core/evidence/profiles';
import { readingsForCheck, verifiedFactsFrom, withinProfile } from '@/core/evidence/verification';

/**
 * The boundary between what was read and what the case knows.
 *
 * A reading is a proposal. It becomes a fact when a person says it is right,
 * and by no other route — not by confidence, not by a client posting values,
 * not by a field the document could never have carried.
 */

const ANALYSIS: EvidenceAnalysis = {
  legibility: 'PARTIAL',
  observations: [
    { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE', confidence: 0.97, status: 'READ' },
    { field: 'DATE', value: '2026-01-04', confidence: 0.6, status: 'READ' },
    { field: 'TIME_FROM', value: '', confidence: 0.2, status: 'UNREADABLE' },
  ],
  unreadableRegions: ['the lower third of the ticket is creased'],
};

describe('what the user is asked to confirm', () => {
  it('offers only readings there is something to agree with', () => {
    const readings = readingsForCheck(ANALYSIS);
    expect(readings.map((r) => r.confirmable)).toEqual([true, true, false]);
    expect(confirmableObservations(ANALYSIS)).toHaveLength(2);
  });

  it('flags a low-confidence reading without excusing it', () => {
    const readings = readingsForCheck(ANALYSIS);
    // Both are confirmable. Confidence changes the nudge, never the requirement.
    expect(readings[1]?.hint).toMatch(/less sure/i);
    expect(readings[1]?.confirmable).toBe(true);
    expect(readings[0]?.hint).toBeNull();
  });
});

describe('turning confirmations into facts', () => {
  it('produces only what the user ticked', () => {
    expect(verifiedFactsFrom(ANALYSIS, [0])).toEqual([
      { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' },
    ]);
  });

  it('produces nothing when the user ticked nothing', () => {
    // A real answer: the user says we read their document wrong.
    expect(verifiedFactsFrom(ANALYSIS, [])).toEqual([]);
  });

  it('cannot be made to confirm an unreadable observation', () => {
    expect(verifiedFactsFrom(ANALYSIS, [2])).toEqual([]);
  });

  it('ignores an index that points at nothing', () => {
    /*
     * The wire carries positions, not values, so a caller cannot post a reading
     * into their own case. An index off the end of the analysis resolves to
     * nothing rather than to something invented.
     */
    expect(verifiedFactsFrom(ANALYSIS, [9])).toEqual([]);
  });

  it('takes the value we read, never one supplied back to us', () => {
    const facts = verifiedFactsFrom(ANALYSIS, [0, 1]);
    expect(facts.map((f) => f.value)).toEqual(['AB12CDE', '2026-01-04']);
  });
});

describe('what each kind of document may carry', () => {
  it('drops a reading the document type could never hold', () => {
    /*
     * A permit expiry date read off a photograph of a road marking. There is no
     * formatting mistake this could be; it is a reading with no source, and it
     * must not reach a confirmation screen where a user might tick it.
     */
    const stray: EvidenceAnalysis = {
      legibility: 'CLEAR',
      observations: [
        { field: 'MARKINGS_DESCRIPTION', value: 'Single yellow line, worn', confidence: 0.9, status: 'READ' },
        { field: 'VALID_TO', value: '2026-12-31', confidence: 0.9, status: 'READ' },
      ],
      unreadableRegions: [],
    };
    const filtered = withinProfile('ROAD_MARKINGS', stray);
    expect(filtered.observations.map((o) => o.field)).toEqual(['MARKINGS_DESCRIPTION']);
  });

  it('keeps every profile inside the closed field vocabulary', () => {
    for (const profile of Object.values(EVIDENCE_ANALYSIS_PROFILES)) {
      for (const field of profile.fields) {
        expect(EVIDENCE_FIELDS, `${profile.type} names a field that does not exist`).toContain(field);
      }
      expect(profile.fields.length, `${profile.type} authorises nothing`).toBeGreaterThan(0);
    }
  });

  it('does not read a Blue Badge holder off the badge', () => {
    /*
     * A Blue Badge carries a photograph and a name. Neither is anything to do
     * with whether a penalty was correctly issued, and reading health-adjacent
     * personal data because it happens to be in the frame is not something a
     * parking tool gets to do.
     */
    const badge = profileFor('BLUE_BADGE');
    expect(badge?.fields).toEqual(['BADGE_SERIAL', 'VALID_TO', 'ISSUING_BODY']);
    expect(badge?.readingGuidance).toMatch(/not read.*name/i);
  });

  it('reads nothing off a document type it has no profile for', () => {
    // Held, and honestly worth nothing until somebody adds a profile for it.
    expect(isAnalysable('WITNESS_INFORMATION')).toBe(false);
    expect(withinProfile('WITNESS_INFORMATION', ANALYSIS).observations).toEqual([]);
  });
});
