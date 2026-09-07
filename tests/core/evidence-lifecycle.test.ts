import { describe, expect, it } from 'vitest';
import {
  EVIDENCE_STATUSES,
  countEvidence,
  isHeld,
  supportsAssessment,
  type EvidenceItem,
} from '@/core/evidence/lifecycle';
import { evidenceItem } from '../fixtures/evidence';

/**
 * The four states, and what each one is worth.
 *
 * Every test here is about one boundary: the difference between a file we hold
 * and a document that supports somebody's case. Collapsing that boundary is the
 * single most damaging thing this feature could do — it would tell a person
 * their case was evidenced on the strength of a photograph nobody had looked
 * at, including us.
 */

describe('what an evidence item is worth', () => {
  it('keeps all four states distinct', () => {
    expect(EVIDENCE_STATUSES).toEqual(['DECLARED', 'UPLOADED', 'ANALYSED', 'VERIFIED']);
  });

  it('does not count a declaration as evidence we hold', () => {
    // The user says they have a permit. We have never seen it.
    expect(isHeld('DECLARED')).toBe(false);
    expect(supportsAssessment(evidenceItem('PERMIT', 'DECLARED'))).toBe(false);
  });

  it('does not let an upload support the case on its own', () => {
    const uploaded = evidenceItem('PERMIT', 'UPLOADED');
    expect(isHeld(uploaded.status)).toBe(true);
    expect(supportsAssessment(uploaded)).toBe(false);
  });

  it('does not let a reading support the case before the user has checked it', () => {
    const analysed = evidenceItem('PERMIT', 'ANALYSED');
    expect(analysed.analysis?.observations.length).toBeGreaterThan(0);
    expect(supportsAssessment(analysed)).toBe(false);
  });

  it('supports the case once the user has confirmed a reading', () => {
    expect(supportsAssessment(evidenceItem('PERMIT', 'VERIFIED'))).toBe(true);
  });

  it('does not let an unreadable file support the case, however it was verified', () => {
    /*
     * The dangerous combination: a file we could not make out, on an item the
     * user pressed the button on anyway. Legibility is checked independently of
     * status precisely so that "confirmed" cannot rescue "we could not read
     * it".
     */
    const unreadable = evidenceItem('PERMIT', 'VERIFIED', { legibility: 'UNREADABLE' });
    expect(supportsAssessment(unreadable)).toBe(false);
  });

  it('does not support the case when the user rejected every reading', () => {
    const rejected = evidenceItem('PERMIT', 'VERIFIED', { verifiedFacts: [] });
    expect(supportsAssessment(rejected)).toBe(false);
  });

  it('never lets model confidence stand in for a person', () => {
    /*
     * A perfect score on every reading, and nobody has confirmed one. If
     * confidence could promote an item this would pass, which is the whole
     * reason it is asserted rather than assumed.
     */
    const certain: EvidenceItem = evidenceItem('PAYMENT_RECEIPT', 'ANALYSED', {
      analysis: {
        legibility: 'CLEAR',
        observations: [
          { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE', confidence: 1, status: 'READ' },
          { field: 'DATE', value: '2026-01-04', confidence: 1, status: 'READ' },
        ],
        unreadableRegions: [],
      },
    });
    expect(supportsAssessment(certain)).toBe(false);
  });
});

describe('counting evidence', () => {
  it('counts held and supporting separately', () => {
    const counts = countEvidence([
      evidenceItem('PCN_IMAGE', 'VERIFIED'),
      evidenceItem('PERMIT', 'UPLOADED'),
      evidenceItem('PERMIT', 'ANALYSED'),
      evidenceItem('BLUE_BADGE', 'DECLARED'),
    ]);

    // Three files exist; one document backs anything up.
    expect(counts.held).toEqual({ PCN_IMAGE: 1, PERMIT: 2 });
    expect(counts.supporting).toEqual({ PCN_IMAGE: 1 });
    expect(counts.supporting.PERMIT).toBeUndefined();
    expect(counts.held.BLUE_BADGE).toBeUndefined();
  });
});
