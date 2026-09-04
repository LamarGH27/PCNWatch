import { describe, expect, it } from 'vitest';
import { decideAdminAccess, parseAllowlist } from '@/server/admin/auth';
import {
  STALENESS_THRESHOLD_HOURS,
  STUCK_RUN_THRESHOLD_MINUTES,
  summariseHealth,
} from '@/server/admin/data-health';

const NOW = Date.parse('2026-01-15T12:00:00.000Z');
const SOURCES = [{ id: 'src-1', slug: 'camden-pcn', name: 'Camden PCNs' }];

function run(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    source_id: 'src-1',
    status: 'SUCCEEDED',
    started_at: '2026-01-15T03:00:00.000Z',
    finished_at: '2026-01-15T03:05:00.000Z',
    inserted: 1200,
    updated: 30,
    rejected: 4,
    not_geolocated: 18,
    ...overrides,
  } as Parameters<typeof summariseHealth>[1][number];
}

describe('admin access', () => {
  it('denies everyone when the allow-list is empty', () => {
    expect(decideAdminAccess([], 'someone@example.com')).toEqual({
      allowed: false,
      reason: 'ALLOWLIST_EMPTY',
    });
  });

  it('denies an anonymous visitor', () => {
    expect(decideAdminAccess(['admin@example.com'], null).allowed).toBe(false);
  });

  it('denies a signed-in user who is not on the list', () => {
    const result = decideAdminAccess(['admin@example.com'], 'someone.else@example.com');
    expect(result).toEqual({ allowed: false, reason: 'NOT_ON_ALLOWLIST' });
  });

  it('allows a listed user, case-insensitively', () => {
    expect(decideAdminAccess(['admin@example.com'], 'Admin@Example.COM').allowed).toBe(true);
  });

  it('parses an allow-list tolerantly but does not invent entries', () => {
    expect(parseAllowlist(' a@x.com , B@X.com ,, ')).toEqual(['a@x.com', 'b@x.com']);
    expect(parseAllowlist('')).toEqual([]);
    expect(parseAllowlist('   ')).toEqual([]);
  });
});

describe('data health summary', () => {
  it('reports a fresh, successful source', () => {
    const health = summariseHealth(SOURCES, [run()], [], [], NOW);
    const source = health.sources[0];
    expect(source?.lastRunStatus).toBe('SUCCEEDED');
    expect(source?.stale).toBe(false);
    expect(source?.rowsInserted).toBe(1200);
    expect(source?.notGeolocated).toBe(18);
  });

  it('treats a source that has never succeeded as stale, never healthy', () => {
    const health = summariseHealth(
      SOURCES,
      [run({ status: 'FAILED', finished_at: '2026-01-15T03:05:00.000Z' })],
      [],
      [],
      NOW,
    );
    expect(health.sources[0]?.stale).toBe(true);
    expect(health.sources[0]?.freshnessHours).toBeNull();
  });

  it('treats a source with no runs at all as stale', () => {
    const health = summariseHealth(SOURCES, [], [], [], NOW);
    expect(health.sources[0]?.stale).toBe(true);
    expect(health.sources[0]?.lastRunStatus).toBeNull();
  });

  it('marks a source stale past the freshness threshold', () => {
    const old = new Date(NOW - (STALENESS_THRESHOLD_HOURS + 1) * 3_600_000).toISOString();
    const health = summariseHealth(
      SOURCES,
      [run({ started_at: old, finished_at: old })],
      [],
      [],
      NOW,
    );
    expect(health.sources[0]?.stale).toBe(true);
  });

  it('counts a PARTIAL run as a successful ingestion for freshness', () => {
    const health = summariseHealth(SOURCES, [run({ status: 'PARTIAL' })], [], [], NOW);
    expect(health.sources[0]?.stale).toBe(false);
  });

  it('uses the most recent run for the headline status', () => {
    const health = summariseHealth(
      SOURCES,
      [
        run({ id: 'older', started_at: '2026-01-14T03:00:00.000Z', status: 'SUCCEEDED' }),
        run({ id: 'newer', started_at: '2026-01-15T03:00:00.000Z', status: 'FAILED', finished_at: null }),
      ],
      [],
      [],
      NOW,
    );
    expect(health.sources[0]?.lastRunStatus).toBe('FAILED');
    // But freshness still reflects the last run that actually succeeded.
    expect(health.sources[0]?.freshnessHours).not.toBeNull();
  });

  it('surfaces the most common rejection reasons for the latest run', () => {
    const errors = [
      { ingestion_run_id: 'run-1', error_code: 'MISSING_OR_INVALID_DATE' },
      { ingestion_run_id: 'run-1', error_code: 'MISSING_OR_INVALID_DATE' },
      { ingestion_run_id: 'run-1', error_code: 'MISSING_STREET' },
    ];
    const health = summariseHealth(SOURCES, [run()], errors, [], NOW);
    expect(health.sources[0]?.topErrorCodes[0]).toEqual({
      code: 'MISSING_OR_INVALID_DATE',
      count: 2,
    });
  });

  it('flags a run that has been RUNNING beyond the stuck threshold', () => {
    const stuckStart = new Date(NOW - (STUCK_RUN_THRESHOLD_MINUTES + 5) * 60_000).toISOString();
    const health = summariseHealth(
      SOURCES,
      [run({ status: 'RUNNING', started_at: stuckStart, finished_at: null })],
      [],
      [],
      NOW,
    );
    expect(health.stuckRuns).toHaveLength(1);
    expect(health.stuckRuns[0]?.sourceSlug).toBe('camden-pcn');
  });

  it('does not flag a run that has only just started', () => {
    const recent = new Date(NOW - 60_000).toISOString();
    const health = summariseHealth(
      SOURCES,
      [run({ status: 'RUNNING', started_at: recent, finished_at: null })],
      [],
      [],
      NOW,
    );
    expect(health.stuckRuns).toHaveLength(0);
  });

  it('counts model-output rejections separately from errors', () => {
    const health = summariseHealth(
      SOURCES,
      [run()],
      [],
      [
        { validation_result: 'ACCEPTED' },
        { validation_result: 'ACCEPTED' },
        { validation_result: 'SCHEMA_REJECTED' },
        { validation_result: 'CITATION_REJECTED' },
        { validation_result: 'ERROR' },
      ],
      NOW,
    );
    expect(health.ai).toEqual({
      totalCalls: 5,
      accepted: 2,
      schemaRejected: 1,
      citationRejected: 1,
      errors: 1,
    });
  });
});
