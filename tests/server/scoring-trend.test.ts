import { describe, expect, it } from 'vitest';
import { trendLabelFor } from '@/server/ingestion/scoring-job';

describe('scoring job trend labelling', () => {
  const trend = (value: number) => trendLabelFor([{ key: 'trend', value }]);

  it('labels a clearly rising trend', () => {
    expect(trend(0.85)).toBe('RISING');
    expect(trend(0.58)).toBe('RISING');
  });

  it('labels a clearly falling trend', () => {
    expect(trend(0.1)).toBe('FALLING');
    expect(trend(0.42)).toBe('FALLING');
  });

  it('keeps a dead band around neutral so a trend does not flip on noise', () => {
    expect(trend(0.5)).toBe('STABLE');
    expect(trend(0.52)).toBe('STABLE');
    expect(trend(0.45)).toBe('STABLE');
    expect(trend(0.5699)).toBe('STABLE');
  });

  it('reports UNKNOWN when there is no trend component at all', () => {
    expect(trendLabelFor([])).toBe('UNKNOWN');
    expect(trendLabelFor([{ key: 'volume', value: 0.9 }])).toBe('UNKNOWN');
  });
});
