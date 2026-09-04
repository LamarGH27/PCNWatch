import { describe, expect, it } from 'vitest';
import {
  assessCoverage,
  COVERAGE_SCOPE,
  isAuthorityInMapScope,
  MIN_EVENTS_FOR_COVERAGE,
  type CoverageEvidence,
} from '@/core/coverage/coverage';

function evidence(overrides: Partial<CoverageEvidence> = {}): CoverageEvidence {
  return {
    configuredLive: true,
    eventCount: 5000,
    lastSuccessfulIngestionAt: '2026-01-14T03:00:00.000Z',
    sourceUnavailable: false,
    isDemoData: false,
    ...overrides,
  };
}

describe('coverage', () => {
  it('reports coverage only when data has actually been ingested', () => {
    const result = assessCoverage('camden', 'Camden', evidence());
    expect(result.state).toBe('COVERED');
    expect(result.canShowActivity).toBe(true);
    expect(result.lastUpdated).toBeTruthy();
  });

  it('never claims coverage from configuration alone', () => {
    const result = assessCoverage(
      'camden',
      'Camden',
      evidence({ eventCount: 0, lastSuccessfulIngestionAt: null }),
    );
    expect(result.state).toBe('NO_COVERAGE');
    expect(result.canShowActivity).toBe(false);
  });

  it('refuses coverage below the minimum event count', () => {
    const result = assessCoverage(
      'camden',
      'Camden',
      evidence({ eventCount: MIN_EVENTS_FOR_COVERAGE - 1 }),
    );
    expect(result.state).toBe('NO_COVERAGE');
    expect(result.canShowActivity).toBe(false);
  });

  it('refuses coverage for an authority not configured as live', () => {
    const result = assessCoverage('islington', 'Islington', evidence({ configuredLive: false }));
    expect(result.state).toBe('NO_COVERAGE');
    expect(result.headline).toContain('not covered yet');
  });

  it('distinguishes a datastore failure from an absence of enforcement', () => {
    const result = assessCoverage('camden', 'Camden', evidence({ sourceUnavailable: true }));
    expect(result.state).toBe('TEMPORARILY_UNAVAILABLE');
    expect(result.headline).toBe('Data temporarily unavailable');
    expect(result.canShowActivity).toBe(false);
    // Critically: it must not read as "no tickets are issued here".
    expect(result.detail).toContain('not a statement about enforcement activity');
  });

  it('forces a banner when the data is demo data', () => {
    const result = assessCoverage('camden', 'Camden', evidence({ isDemoData: true }));
    expect(result.state).toBe('DEMO_DATA');
    expect(result.requiresDemoBanner).toBe(true);
    expect(result.detail.toLowerCase()).toContain('fabricated');
  });

  it('treats a datastore failure as more important than a demo flag', () => {
    const result = assessCoverage(
      'camden',
      'Camden',
      evidence({ sourceUnavailable: true, isDemoData: true }),
    );
    expect(result.state).toBe('TEMPORARILY_UNAVAILABLE');
  });

  it('states the map scope in exactly one place', () => {
    expect(COVERAGE_SCOPE.liveAuthoritySlugs).toEqual(['camden']);
    expect(isAuthorityInMapScope('camden')).toBe(true);
    expect(isAuthorityInMapScope('islington')).toBe(false);
    expect(COVERAGE_SCOPE.statement.toLowerCase()).toContain('camden');
  });

  it('never marks canShowActivity true without a state that permits it', () => {
    const cases: CoverageEvidence[] = [
      evidence({ sourceUnavailable: true }),
      evidence({ configuredLive: false }),
      evidence({ eventCount: 0 }),
      evidence({ lastSuccessfulIngestionAt: null }),
    ];
    for (const e of cases) {
      expect(assessCoverage('camden', 'Camden', e).canShowActivity).toBe(false);
    }
  });
});
