import { redactRegistrations } from '@/data-sources/shared/pii';

/**
 * Scrubbing diagnostics before they are stored.
 *
 * A failed run records why it failed, and that text is read back by anyone with
 * access to the runs table. The message is whatever threw — and the things that
 * throw during ingestion are exactly the things that hold secrets: the Postgres
 * driver quotes the connection string, `fetch` quotes the request URL including
 * its app token, an HTTP client quotes the Authorization header.
 *
 * Relying on none of those ever including a credential is not a guarantee, so
 * the scrubbing happens here, at the boundary where the message is written,
 * rather than being asked of every caller. Anything that looks like a
 * credential is replaced whether or not it is one: a redacted diagnostic is a
 * worse debugging experience, a leaked one is an incident.
 *
 * Vehicle registrations go the same way. A rejected row's text can carry one,
 * and the runs table is not the place for personal data.
 */

export const DIAGNOSTIC_PLACEHOLDER = '[redacted]';

/** Longest diagnostic kept. Beyond this a message is a payload, not an explanation. */
const MAX_LENGTH = 2000;

const SCRUBBERS: readonly { readonly pattern: RegExp; readonly replacement: string }[] = [
  // Credentials inside a URL: postgres://user:password@host, https://key@host.
  // Quantifiers are bounded throughout. Left open-ended, each one backtracks
  // across every position of a long line looking for a delimiter that is not
  // there, which turns a large message into a quadratic scan.
  {
    pattern: /([a-z][a-z0-9+.-]{0,15}:\/\/)[^/\s:@]{1,256}(?::[^/\s@]{0,256})?@/gi,
    replacement: `$1${DIAGNOSTIC_PLACEHOLDER}@`,
  },
  // Secret-bearing query parameters, including Socrata's $$app_token.
  {
    pattern: /([?&]\${0,2}[A-Za-z0-9_.-]{0,40}(?:token|key|secret|password|passwd|pwd|auth|signature|sig)[A-Za-z0-9_.-]{0,40}=)[^&\s"'`]{1,512}/gi,
    replacement: `$1${DIAGNOSTIC_PLACEHOLDER}`,
  },
  // Authorization headers quoted back at us.
  { pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,512}/gi, replacement: `$1 ${DIAGNOSTIC_PLACEHOLDER}` },
  // JSON Web Tokens — Supabase anon and service keys are this shape.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{6,512}\.[A-Za-z0-9_-]{6,512}\.[A-Za-z0-9_-]{0,512}/g,
    replacement: DIAGNOSTIC_PLACEHOLDER,
  },
  // Supabase's newer prefixed keys, and anything else announcing itself as one.
  { pattern: /\bsb[a-z]?_[A-Za-z0-9_-]{16,512}/gi, replacement: DIAGNOSTIC_PLACEHOLDER },
  // A named credential in prose: password = hunter2, api_key: abc123.
  {
    pattern: /\b(password|passwd|pwd|api[_-]?key|apikey|access[_-]?token|app[_-]?token|secret|authorization)\b(\s{0,8}[:=]\s{0,8})("[^"]{0,512}"|'[^']{0,512}'|\S{1,512})/gi,
    replacement: `$1$2${DIAGNOSTIC_PLACEHOLDER}`,
  },
  // A long unbroken opaque string is a key far more often than it is prose.
  { pattern: /\b[A-Za-z0-9_-]{40,512}\b/g, replacement: DIAGNOSTIC_PLACEHOLDER },
];

/**
 * Makes an error message safe to store on an ingestion run.
 *
 * Returns a short, credential-free, registration-free description. An empty or
 * unusable message becomes a stated absence rather than an empty string, so a
 * run never looks as though it failed for no reason at all.
 */
export function redactDiagnostic(message: string): string {
  let result = message;
  for (const { pattern, replacement } of SCRUBBERS) {
    result = result.replace(pattern, replacement);
  }
  result = redactRegistrations(result);
  result = result.replace(/\s+/g, ' ').trim();

  if (result === '') return 'No diagnostic text was available.';
  if (result.length > MAX_LENGTH) return `${result.slice(0, MAX_LENGTH)}… (truncated)`;
  return result;
}
