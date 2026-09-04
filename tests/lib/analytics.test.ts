import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_EVENTS,
  ForbiddenAnalyticsPropertyError,
  sanitiseProperties,
  scoreBand,
} from '@/lib/analytics';

describe('analytics event coverage', () => {
  it('covers every event the funnel hypotheses need', () => {
    for (const required of [
      'landing_view',
      'map_view',
      'location_search',
      'hotspot_view',
      'pcn_upload_started',
      'pcn_upload_completed',
      'pcn_extraction_verified',
      'assessment_view',
      'checkout_started',
      'checkout_completed',
      'draft_generated',
      'case_closed',
    ]) {
      expect(ANALYTICS_EVENTS).toContain(required);
    }
  });
});

describe('property sanitisation', () => {
  it('passes allowed properties through unchanged', () => {
    const clean = sanitiseProperties({
      authority_slug: 'camden',
      contravention_code: '01',
      score_band: 'high',
      result_count: 12,
    });
    expect(clean).toEqual({
      authority_slug: 'camden',
      contravention_code: '01',
      score_band: 'high',
      result_count: 12,
    });
  });

  it('throws in development on a PCN number', () => {
    expect(() => sanitiseProperties({ pcn_number: 'CA12345678' }, true)).toThrow(
      ForbiddenAnalyticsPropertyError,
    );
  });

  it('throws in development on a vehicle registration', () => {
    expect(() => sanitiseProperties({ vrm: 'AB12CDE' }, true)).toThrow();
    expect(() => sanitiseProperties({ vehicle_registration: 'AB12CDE' }, true)).toThrow();
    expect(() => sanitiseProperties({ registration_plate: 'AB12CDE' }, true)).toThrow();
  });

  it('throws in development on names, addresses and contact details', () => {
    for (const key of ['name', 'full_name', 'address', 'email', 'phone', 'postcode']) {
      expect(() => sanitiseProperties({ [key]: 'value' }, true)).toThrow();
    }
  });

  it('throws in development on document content', () => {
    for (const key of ['document_text', 'file_content', 'narrative', 'body']) {
      expect(() => sanitiseProperties({ [key]: 'value' }, true)).toThrow();
    }
  });

  it('drops rather than throws in production, so a leak never ships', () => {
    const clean = sanitiseProperties(
      { authority_slug: 'camden', pcn_number: 'CA12345678', vrm: 'AB12CDE' },
      false,
    );
    expect(clean).toEqual({ authority_slug: 'camden' });
    expect(JSON.stringify(clean)).not.toContain('CA12345678');
    expect(JSON.stringify(clean)).not.toContain('AB12CDE');
  });

  it('drops an unknown key even when it looks harmless', () => {
    // Allow-list, not deny-list: anything not explicitly permitted is dropped.
    expect(sanitiseProperties({ some_new_field: 'x' }, false)).toEqual({});
  });

  it('drops a user identifier', () => {
    expect(sanitiseProperties({ user_id: 'abc' }, false)).toEqual({});
  });

  it('drops non-scalar values', () => {
    const clean = sanitiseProperties(
      { authority_slug: 'camden', period_key: { nested: true } as unknown as string },
      false,
    );
    expect(clean).toEqual({ authority_slug: 'camden' });
  });

  it('accepts an empty property set', () => {
    expect(sanitiseProperties({})).toEqual({});
  });
});

describe('score banding', () => {
  it('sends a band rather than a raw score', () => {
    expect(scoreBand(0)).toBe('very_low');
    expect(scoreBand(19)).toBe('very_low');
    expect(scoreBand(20)).toBe('low');
    expect(scoreBand(59)).toBe('moderate');
    expect(scoreBand(60)).toBe('high');
    expect(scoreBand(100)).toBe('very_high');
  });

  it('has a band for an unscored location', () => {
    expect(scoreBand(null)).toBe('unscored');
  });
});
