import { describe, expect, it } from 'vitest';
import { redactDiagnostic } from '@/server/ingestion/diagnostics';

/**
 * A failed run records why it failed, and that text is stored and read back.
 * The things that throw during ingestion are the ones holding credentials: the
 * Postgres driver quotes the connection string, fetch quotes the request URL
 * with its app token. Each case below is a message one of them really produces.
 */
describe('scrubbing what a failed run records', () => {
  it('removes the password from a Postgres connection string', () => {
    const out = redactDiagnostic(
      'connect ECONNREFUSED postgres://pcnwatch:s3cr3t-pass@db.abcdefg.supabase.co:5432/postgres',
    );
    expect(out).not.toContain('s3cr3t-pass');
    expect(out).not.toContain('pcnwatch:');
    // The host survives, because knowing which database refused you is the
    // whole value of the message.
    expect(out).toContain('db.abcdefg.supabase.co:5432/postgres');
  });

  it('removes an app token from a request URL', () => {
    const out = redactDiagnostic(
      'HTTP 429 for https://opendata.camden.gov.uk/resource/4k7m-4gkk.json?$limit=50000&$$app_token=AbCdEf123456&$offset=0',
    );
    expect(out).not.toContain('AbCdEf123456');
    expect(out).toContain('$limit=50000');
    expect(out).toContain('HTTP 429');
  });

  it('removes an Authorization header quoted back at us', () => {
    const out = redactDiagnostic('401 Unauthorized (sent Bearer abc123def456ghi789jkl)');
    expect(out).not.toContain('abc123def456ghi789jkl');
    expect(out).toContain('401 Unauthorized');
  });

  it('removes a Supabase key, whichever shape it takes', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.QWxsWW91ck5lZWQ';
    expect(redactDiagnostic(`invalid key ${jwt}`)).not.toContain(jwt);

    const prefixed = 'sb_secret_9aZQ1x8LmN0pQrStUvWx';
    expect(redactDiagnostic(`rejected ${prefixed}`)).not.toContain(prefixed);
  });

  it('removes a credential named in prose', () => {
    const out = redactDiagnostic('auth failed (password = hunter2, api_key: zzz999)');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('zzz999');
  });

  it('removes a vehicle registration, which is personal data', () => {
    const out = redactDiagnostic('rejected row for AB12 CDE: no usable date');
    expect(out).not.toContain('AB12 CDE');
    expect(out).toContain('no usable date');
  });

  it('leaves an ordinary diagnostic intact', () => {
    const message =
      'Aggregate totals do not reconcile: stored 485000 against 485564 accepted source records.';
    expect(redactDiagnostic(message)).toBe(message);
  });

  it('never returns an empty reason, so a run cannot look like it failed for nothing', () => {
    expect(redactDiagnostic('')).toBe('No diagnostic text was available.');
    expect(redactDiagnostic('   ')).toBe('No diagnostic text was available.');
  });

  it('truncates a payload masquerading as a message', () => {
    const out = redactDiagnostic('row rejected. '.repeat(4_000));
    expect(out.length).toBeLessThan(2100);
    expect(out.endsWith('… (truncated)')).toBe(true);
  });

  it('scans a long message in reasonable time rather than backtracking over it', () => {
    // Every pattern is bounded for this reason: an unbounded quantifier hunting
    // for a delimiter that is not there turns one long line into a quadratic
    // scan, and a run that failed on a huge payload would then hang recording
    // why.
    const started = Date.now();
    redactDiagnostic('x'.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
