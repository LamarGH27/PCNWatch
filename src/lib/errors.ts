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
 * A message that says what actually went wrong.
 *
 * `error.message` alone is not enough for two common shapes. An AggregateError
 * carries an empty message and puts the real causes in `.errors` — which is what
 * a failed database connection throws, so a build against an unreachable
 * database logged `"message": ""` and a stack with no reason in it. A wrapped
 * error hides its reason in `.cause` the same way.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  const parts: string[] = [];
  if (error.message) parts.push(error.message);

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

export function logInfo(scope: string, message: string, context: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: 'info', scope, message, ...context }));
}
