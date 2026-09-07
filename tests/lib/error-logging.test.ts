import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, logError } from '@/lib/errors';

/**
 * What a log line says when something fails.
 *
 * The first real evidence upload in Preview logged this:
 *
 *   {"scope":"evidence.upload","message":"[object Object]", ...}
 *
 * Everything needed to diagnose it was in the object that produced that string.
 * PostgREST rejects with a plain object rather than an Error, `describeError`
 * fell through to `String(error)`, and a one-line answer — 42501, new row
 * violates row-level security policy — became a stringified nothing.
 *
 * The other half of the job is restraint. These errors travel from Supabase
 * carrying whatever the client was holding, and a Postgres `details` line will
 * happily print the row that failed. On `pcn_evidence` that row holds the
 * contents of somebody's documents.
 */

const captured: string[] = [];

afterEach(() => {
  captured.length = 0;
  vi.restoreAllMocks();
});

function capture(error: unknown, context: Record<string, unknown> = {}): string {
  const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => {
    captured.push(line);
  });
  logError('test.scope', error, context);
  spy.mockRestore();
  return captured.at(-1) ?? '';
}

describe('a structured error says what went wrong', () => {
  it('reads a PostgREST rejection instead of stringifying it', () => {
    // Verbatim shape of the rejection that broke the first real upload.
    const rejection = {
      code: '42501',
      message: 'new row violates row-level security policy for table "pcn_evidence"',
      details: null,
      hint: null,
    };

    const described = describeError(rejection);
    expect(described).not.toContain('[object Object]');
    expect(described).toContain('42501');
    expect(described).toContain('row-level security policy');
  });

  it('reads a storage error, which is an Error whose status is the diagnosis', () => {
    const storageError = Object.assign(new Error('Bucket not found'), {
      name: 'StorageApiError',
      status: 404,
      statusCode: '404',
    });

    const described = describeError(storageError);
    expect(described).toContain('Bucket not found');
    expect(described).toContain('status=404');
  });

  it('keeps the Postgres fields that name a constraint', () => {
    const described = describeError({
      code: '23505',
      message: 'duplicate key value violates unique constraint "pcn_evidence_storage_path_key"',
      details: 'Key (storage_path)=(a/b/c.jpg) already exists.',
      hint: null,
    });
    expect(described).toContain('23505');
    expect(described).toContain('pcn_evidence_storage_path_key');
  });

  it('never returns "[object Object]", whatever the shape', () => {
    for (const shape of [
      {},
      { weird: true },
      { message: '' },
      Object.create(null) as object,
      { code: 'X' },
    ]) {
      expect(describeError(shape)).not.toContain('[object Object]');
    }
    // Even an empty object says something useful about what it was handed.
    expect(describeError({ weird: true })).toContain('weird');
  });

  it('still describes Errors and primitives as before', () => {
    expect(describeError(new Error('plain failure'))).toContain('plain failure');
    expect(describeError('boom')).toBe('boom');
    expect(describeError(new Error('outer', { cause: new Error('inner') }))).toContain('inner');

    const aggregate = new AggregateError(
      [new Error('ECONNREFUSED ::1'), new Error('ECONNREFUSED 127.0.0.1')],
      '',
    );
    expect(describeError(aggregate)).toContain('ECONNREFUSED ::1');
    expect(describeError(aggregate)).toContain('127.0.0.1');
  });
});

describe('a log line never carries the things it must not', () => {
  it('withholds a Postgres detail line that quotes the failing row', () => {
    /*
     * The shape that would leak. On a NOT NULL or CHECK violation Postgres
     * prints every column of the row, and on `pcn_evidence` that includes the
     * filename the user chose and the readings taken off their document.
     */
    const described = describeError({
      code: '23502',
      message: 'null value in column "user_id" violates not-null constraint',
      details:
        'Failing row contains (a1b2, case-1, null, PERMIT, UPLOADED, u/c/x.jpg, ' +
        'my-blue-badge-scan.jpg, image/jpeg, 120000, {"observations":[{"field":' +
        '"VEHICLE_REGISTRATION","value":"AB12CDE"}]}).',
      hint: null,
    });

    expect(described).toContain('23502');
    expect(described).toContain('not-null constraint');
    // None of the row survives.
    expect(described).not.toContain('my-blue-badge-scan');
    expect(described).not.toContain('AB12CDE');
    expect(described).not.toContain('VEHICLE_REGISTRATION');
    expect(described).toContain('row contents withheld');
  });

  it('takes only the fields on the allowlist, never the whole object', () => {
    /*
     * An allowlist rather than a redaction pass, so a field nobody anticipated
     * is excluded by default. A storage error really can arrive holding the
     * signed URL it was fetching.
     */
    const described = describeError({
      code: '42501',
      message: 'refused',
      signedUrl: 'https://project.supabase.co/storage/v1/object/sign/pcn-evidence/x?token=eyJhb',
      access_token: 'eyJhbGciOiJIUzI1NiJ9.SECRET',
      apikey: 'service-role-key-value',
      file: 'raw bytes of the photograph',
      pcnNumber: 'CM12345678',
      vehicleRegistration: 'AB12 CDE',
    });

    for (const secret of [
      'token=eyJhb',
      'eyJhbGciOiJIUzI1NiJ9',
      'service-role-key-value',
      'raw bytes',
      'CM12345678',
      'AB12 CDE',
    ]) {
      expect(described, `${secret} reached the log`).not.toContain(secret);
    }
    expect(described).toContain('42501');
  });

  it('truncates a diagnostic field that unexpectedly carries a payload', () => {
    const described = describeError({ code: 'X', message: 'm', hint: 'y'.repeat(5_000) });
    expect(described.length).toBeLessThan(1_000);
    expect(described).toContain('…');
  });

  it('writes the stage and the ids, and nothing else, to the log line', () => {
    const line = capture(
      { code: '42501', message: 'new row violates row-level security policy' },
      { caseId: '2edc68dd-8af4-4fa4-978f-82f7e4c7c0cf', stage: 'ROW_INSERT' },
    );
    const payload = JSON.parse(line) as Record<string, unknown>;

    expect(payload.scope).toBe('test.scope');
    expect(payload.stage).toBe('ROW_INSERT');
    expect(payload.caseId).toBe('2edc68dd-8af4-4fa4-978f-82f7e4c7c0cf');
    expect(String(payload.message)).toContain('42501');
    expect(String(payload.message)).not.toContain('[object Object]');
    expect(payload.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
