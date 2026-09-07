import { randomUUID } from 'node:crypto';

/**
 * User-facing error contract.
 *
 * Every failure the user can see answers three questions: what failed, whether
 * their data was saved, and what they can do next. A correlation id ties the
 * message they see to the server logs, without exposing a stack trace.
 */

export type ErrorSeverity = 'RECOVERABLE' | 'BLOCKING';

export interface UserFacingError {
  readonly correlationId: string;
  readonly code: string;
  /** What failed, in plain language. */
  readonly what: string;
  /** Whether anything the user did was persisted. */
  readonly dataSaved: boolean;
  /** What the user can do now. */
  readonly whatYouCanDo: string;
  readonly severity: ErrorSeverity;
}

export class AppError extends Error {
  readonly correlationId: string;

  constructor(
    readonly code: string,
    readonly what: string,
    readonly whatYouCanDo: string,
    readonly options: {
      readonly dataSaved?: boolean;
      readonly severity?: ErrorSeverity;
      readonly cause?: unknown;
      readonly correlationId?: string;
    } = {},
  ) {
    super(`${code}: ${what}`);
    this.name = 'AppError';
    this.correlationId = options.correlationId ?? newCorrelationId();
    if (options.cause) this.cause = options.cause;
  }

  toUserFacing(): UserFacingError {
    return {
      correlationId: this.correlationId,
      code: this.code,
      what: this.what,
      dataSaved: this.options.dataSaved ?? false,
      whatYouCanDo: this.whatYouCanDo,
      severity: this.options.severity ?? 'BLOCKING',
    };
  }
}

export function newCorrelationId(): string {
  return randomUUID();
}

/**
 * Converts any thrown value into something safe to show a user.
 * An unknown error never leaks its message; only the correlation id crosses over.
 */
export function toUserFacingError(error: unknown, correlationId?: string): UserFacingError {
  if (error instanceof AppError) return error.toUserFacing();
  return {
    correlationId: correlationId ?? newCorrelationId(),
    code: 'UNEXPECTED_ERROR',
    what: 'Something went wrong that we did not anticipate.',
    dataSaved: false,
    whatYouCanDo:
      'Try again. If it keeps happening, contact us and quote the reference below so we can find the exact failure.',
    severity: 'BLOCKING',
  };
}

/** Structured server log line. Never include personal data in `context`. */
export function logError(
  scope: string,
  error: unknown,
  context: Record<string, unknown> = {},
): string {
  const correlationId = error instanceof AppError ? error.correlationId : newCorrelationId();
  const payload = {
    level: 'error',
    scope,
    correlationId,
    message: describeError(error),
    stack: error instanceof Error ? error.stack : undefined,
    ...context,
  };
  console.error(JSON.stringify(payload));
  return correlationId;
}

/**
 * Fields worth logging from a structured error, and the only ones taken.
 *
 * An allowlist rather than a redaction pass over the whole object. Supabase
 * hands back errors carrying whatever the client was holding — a storage error
 * can reference the signed URL it was fetching, and an auth error the session
 * it was refreshing. Serialising the object and stripping what looks sensitive
 * gets that backwards: it logs everything nobody thought to exclude, including
 * fields a future SDK version invents.
 */
const SAFE_ERROR_FIELDS = ['code', 'status', 'statusCode', 'details', 'hint'] as const;

/**
 * How much of a diagnostic field is worth keeping.
 *
 * Long enough for a constraint name and a Postgres hint, short enough that a
 * field which unexpectedly carries a payload is truncated rather than logged.
 */
const MAX_FIELD_LENGTH = 300;

/**
 * Postgres detail lines that quote the row that failed.
 *
 * `details` is genuinely useful — "Key (storage_path)=(…) already exists" names
 * the conflict — but on a NOT NULL or CHECK violation Postgres writes
 * "Failing row contains (…)" and prints every column. On `pcn_evidence` that
 * row holds `analysis` and `verified_facts`: the registration, permit number
 * or badge serial read off somebody's document, and the filename they chose.
 *
 * So the shape is recognised and dropped. What survives is the fact that there
 * was one, which is all the field was contributing to a diagnosis anyway.
 */
const ROW_DUMP = /^\s*Failing row contains/i;

function safeFieldValue(key: string, value: unknown): string | null {
  if (typeof value === 'number') return String(value);
  if (typeof value !== 'string' || value === '') return null;
  if (ROW_DUMP.test(value)) return '(row contents withheld)';
  return value.length > MAX_FIELD_LENGTH ? `${value.slice(0, MAX_FIELD_LENGTH)}…` : value;
}

/**
 * The diagnostic fields an error is carrying, in `key=value` form.
 *
 * Applied to plain objects and to Errors alike, because Supabase uses both:
 * PostgREST rejects with a bare object holding `code`/`details`/`hint`, while
 * storage throws a `StorageApiError` — an Error subclass whose `status` is the
 * only thing that says what happened.
 */
function structuredFields(error: object): string[] {
  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of SAFE_ERROR_FIELDS) {
    const value = safeFieldValue(key, record[key]);
    if (value !== null) parts.push(`${key}=${value}`);
  }
  return parts;
}

/**
 * A message that says what actually went wrong.
 *
 * `error.message` alone is not enough for three common shapes.
 *
 * An AggregateError carries an empty message and puts the real causes in
 * `.errors` — which is what a failed database connection throws, so a build
 * against an unreachable database logged `"message": ""` and a stack with no
 * reason in it. A wrapped error hides its reason in `.cause` the same way.
 *
 * And a Supabase rejection is frequently not an Error at all. PostgREST returns
 * a plain object, `String()` of which is `"[object Object]"` — which is exactly
 * what the first real evidence upload logged, turning a one-line diagnosis
 * ("42501: new row violates row-level security policy") into an afternoon. A
 * structured error is now read for its fields rather than stringified.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return describeNonError(error);

  const parts: string[] = [];
  if (error.message) parts.push(error.message);

  // A StorageApiError is an Error whose status is the diagnosis.
  const fields = structuredFields(error);
  if (fields.length > 0) parts.push(`(${fields.join(' ')})`);

  if (error instanceof AggregateError && Array.isArray(error.errors)) {
    const causes = error.errors.map((e) => describeError(e)).filter((m) => m !== '');
    // Repeating one message per address family says nothing extra; the distinct
    // set does. ECONNREFUSED on ::1 and on 127.0.0.1 are different facts.
    const distinct = [...new Set(causes)];
    if (distinct.length > 0) parts.push(distinct.join('; '));
  } else if (error.cause !== undefined && error.cause !== null) {
    const cause = describeError(error.cause);
    if (cause !== '') parts.push(`caused by: ${cause}`);
  }

  return parts.join(' — ') || error.name;
}

/**
 * Something thrown that is not an Error.
 *
 * Primitives still stringify — `String('boom')` is the whole message. An object
 * is read for the fields on the allowlist, and never stringified: that is the
 * `[object Object]` path, and it discards the one thing the object was carrying.
 */
function describeNonError(error: unknown): string {
  if (error === null || typeof error !== 'object') return String(error);

  const record = error as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof record.name === 'string' && record.name !== '') parts.push(record.name);
  if (typeof record.message === 'string' && record.message !== '') {
    parts.push(String(safeFieldValue('message', record.message)));
  }

  const fields = structuredFields(record);
  if (fields.length > 0) parts.push(`(${fields.join(' ')})`);

  // Better than "[object Object]" even in the worst case: the caller at least
  // learns the shape it was handed.
  return parts.join(': ') || `unrecognised error shape with keys [${Object.keys(record).sort().join(', ')}]`;
}

export function logInfo(scope: string, message: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', scope, message, ...context }));
}
