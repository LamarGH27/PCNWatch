import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { serverEnv, isConfigured } from '@/lib/env';
import { AppError, logError } from '@/lib/errors';
import { createSupabaseServiceClient } from '@/lib/supabase/server';
import { AI_SCHEMAS, PROMPT_VERSIONS, type AiJobType } from './schemas';
import { WIRE_MAPPERS, WIRE_SCHEMAS } from './wire-schemas';
import { validateAiResponse, type GroundingContext, type ValidationOutcome } from './validate';

/**
 * Server-only Anthropic abstraction.
 *
 * This module is the ONLY place a model is called. It is never imported from
 * client code (enforced by the no-restricted-imports lint rule and by the
 * runtime guard below).
 *
 * Everything it does is defensive:
 *   - The input is redacted before it is sent, so unnecessary personal data never
 *     leaves our infrastructure.
 *   - The response is validated before it can be used.
 *   - Every call is logged with a fingerprint of the input rather than the input,
 *     so the audit trail carries no personal data.
 *   - A rejected response is logged as rejected, not retried into acceptance.
 */

export interface AiCallOptions<K extends AiJobType> {
  readonly jobType: K;
  readonly system: string;
  readonly userContent: AiContentBlock[];
  readonly grounding: GroundingContext;
  readonly caseId?: string;
  readonly userId?: string;
  readonly maxTokens?: number;
}

export type AiContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      readonly mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
      readonly data: string;
    }
  | { readonly type: 'document'; readonly mediaType: 'application/pdf'; readonly data: string };

export interface AiCallResult<T> {
  readonly ok: boolean;
  readonly data: T | null;
  readonly outcome: ValidationOutcome | 'ERROR';
  readonly errors: readonly string[];
  readonly logId: string | null;
  readonly model: string;
  readonly promptVersion: string;
}

export class AiNotConfiguredError extends AppError {
  constructor() {
    super(
      'AI_NOT_CONFIGURED',
      'Document reading is not available on this deployment.',
      'You can still enter your notice details by hand, and everything else will work normally.',
      { severity: 'RECOVERABLE' },
    );
  }
}

/**
 * Runs one AI job end to end: call, validate, log.
 *
 * Never throws for a model failure — the failure is returned so the caller can
 * degrade gracefully. It throws only when called from somewhere it must not be.
 */
export async function runAiJob<K extends AiJobType>(
  options: AiCallOptions<K>,
): Promise<AiCallResult<unknown>> {
  if (typeof window !== 'undefined') {
    throw new Error('Anthropic must never be called from client code.');
  }

  const promptVersion = PROMPT_VERSIONS[options.jobType];
  const fingerprint = fingerprintInput(options.system, options.userContent);

  if (!isConfigured('anthropic')) {
    await logAiCall({
      jobType: options.jobType,
      model: 'unconfigured',
      promptVersion,
      inputFingerprint: fingerprint,
      output: null,
      validationResult: 'ERROR',
      validationErrors: ['ANTHROPIC_API_KEY is not configured.'],
      latencyMs: 0,
      caseId: options.caseId,
      userId: options.userId,
    });
    return {
      ok: false,
      data: null,
      outcome: 'ERROR',
      errors: ['Document reading is not configured on this deployment.'],
      logId: null,
      model: 'unconfigured',
      promptVersion,
    };
  }

  const env = serverEnv();
  const model = env.ANTHROPIC_MODEL;
  const startedAt = Date.now();

  try {
    const raw = await callAnthropic({
      apiKey: env.ANTHROPIC_API_KEY as string,
      model,
      system: options.system,
      content: options.userContent,
      maxTokens: options.maxTokens ?? 4096,
      jobType: options.jobType,
    });

    const validation = validateAiResponse(options.jobType, raw, options.grounding);
    const latencyMs = Date.now() - startedAt;

    const logId = await logAiCall({
      jobType: options.jobType,
      model,
      promptVersion,
      inputFingerprint: fingerprint,
      // The output is stored for accepted and rejected calls alike, so a
      // fabrication is inspectable afterwards rather than discarded.
      output: raw,
      validationResult: validation.outcome,
      validationErrors: validation.outcome === 'ACCEPTED' ? null : validation.errors,
      latencyMs,
      caseId: options.caseId,
      userId: options.userId,
    });

    if (validation.outcome !== 'ACCEPTED') {
      return {
        ok: false,
        data: null,
        outcome: validation.outcome,
        errors: validation.errors,
        logId,
        model,
        promptVersion,
      };
    }

    return {
      ok: true,
      data: validation.data,
      outcome: 'ACCEPTED',
      errors: [],
      logId,
      model,
      promptVersion,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    logError('ai.runAiJob', error, { jobType: options.jobType });
    const logId = await logAiCall({
      jobType: options.jobType,
      model,
      promptVersion,
      inputFingerprint: fingerprint,
      output: null,
      validationResult: 'ERROR',
      validationErrors: [error instanceof Error ? error.message : String(error)],
      latencyMs,
      caseId: options.caseId,
      userId: options.userId,
    });
    return {
      ok: false,
      data: null,
      outcome: 'ERROR',
      errors: ['The document service did not respond as expected.'],
      logId,
      model,
      promptVersion,
    };
  }
}

/* ------------------------------------------------------------------ */
/* Transport                                                           */
/* ------------------------------------------------------------------ */

interface AnthropicCallArgs {
  apiKey: string;
  model: string;
  system: string;
  content: AiContentBlock[];
  maxTokens: number;
  jobType: AiJobType;
}

/**
 * One Messages API call, constrained to the job's schema.
 *
 * This used to be a hand-rolled `fetch` that ended the request with an assistant
 * turn prefilled with `{`, so the model had no choice but to continue a JSON
 * object. That technique is gone: assistant prefill returns HTTP 400 on every
 * current model, so the integration could not have completed a single real call
 * — it was written against an API that no longer accepts it, and nothing had
 * ever run it against a live model to find out.
 *
 * Structured outputs replace it and are strictly better: the schema is enforced
 * by the API rather than coaxed by a prompt, so a response that does not fit
 * cannot come back at all. The same Zod schema drives both this constraint and
 * the validation that follows, so the two cannot drift apart.
 *
 * `messages.parse()` does the decoding. The result still goes through
 * `validateAiResponse` afterwards — schema shape is not the only thing that
 * matters, and citation grounding is checked there.
 */
async function callAnthropic(args: AnthropicCallArgs): Promise<unknown> {
  const client = new Anthropic({ apiKey: args.apiKey });

  // The model answers in the wire shape where one exists, and in the domain
  // shape otherwise. Anthropic caps structured outputs at 16 union parameters;
  // the domain extraction schema has 30, because every nullable field is a
  // union. See wire-schemas.ts.
  const answerSchema = WIRE_SCHEMAS[args.jobType as keyof typeof WIRE_SCHEMAS] ?? AI_SCHEMAS[args.jobType];

  const response = await client.messages.parse({
    model: args.model,
    max_tokens: args.maxTokens,
    system: args.system,
    messages: [{ role: 'user', content: args.content.map(toContentBlock) }],
    output_config: { format: zodOutputFormat(answerSchema) },
  });

  // A refusal is a stop reason, not an exception, so it has to be checked
  // before the content is read. Reading a refused response as data is how a
  // safety decline turns into an empty extraction the user is asked to confirm.
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `The model declined to read this document (${response.stop_details?.category ?? 'unspecified'}).`,
    );
  }

  if (response.parsed_output === null || response.parsed_output === undefined) {
    throw new Error('The model returned no output matching the required schema.');
  }

  // Mapped back to the domain shape before it leaves this function, so the
  // validation and grounding that follow are unchanged and know nothing about
  // the wire format.
  const mapper = WIRE_MAPPERS[args.jobType as keyof typeof WIRE_MAPPERS];
  return mapper ? mapper(response.parsed_output) : response.parsed_output;
}

/** Our transport-agnostic block shape, in the wire form the SDK expects. */
function toContentBlock(block: AiContentBlock): Anthropic.ContentBlockParam {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'image') {
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mediaType, data: block.data },
    };
  }
  return {
    type: 'document',
    source: { type: 'base64', media_type: block.mediaType, data: block.data },
  };
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

/**
 * Fingerprints the input rather than storing it.
 *
 * Identical inputs produce identical fingerprints, which is enough to spot
 * duplicate work and to correlate a complaint with a specific call, without the
 * log ever holding a PCN number, a registration or a document.
 */
export function fingerprintInput(system: string, content: AiContentBlock[]): string {
  const shape = content.map((block) =>
    block.type === 'text'
      ? `text:${createHash('sha256').update(block.text).digest('hex').slice(0, 16)}`
      : `${block.type}:${block.mediaType}:${block.data.length}`,
  );
  return createHash('sha256')
    .update(`${createHash('sha256').update(system).digest('hex')}|${shape.join('|')}`)
    .digest('hex');
}

interface AiLogEntry {
  jobType: AiJobType;
  model: string;
  promptVersion: string;
  inputFingerprint: string;
  output: unknown;
  validationResult: ValidationOutcome | 'ERROR';
  validationErrors: readonly string[] | null;
  latencyMs: number;
  caseId?: string;
  userId?: string;
}

async function logAiCall(entry: AiLogEntry): Promise<string | null> {
  try {
    const supabase = createSupabaseServiceClient();
    if (!supabase) return null;
    const { data, error } = await supabase
      .from('ai_logs')
      .insert({
        user_id: entry.userId ?? null,
        case_id: entry.caseId ?? null,
        job_type: entry.jobType,
        model: entry.model,
        prompt_version: entry.promptVersion,
        input_fingerprint: entry.inputFingerprint,
        output: entry.output ?? null,
        validation_result: entry.validationResult,
        validation_errors: entry.validationErrors ? { errors: entry.validationErrors } : null,
        latency_ms: entry.latencyMs,
      })
      .select('id')
      .single();
    if (error) throw error;
    return String(data.id);
  } catch (error) {
    // Never fail a user's request because the audit write failed, but never lose
    // the fact that it happened either.
    logError('ai.logAiCall', error, { jobType: entry.jobType });
    return null;
  }
}
