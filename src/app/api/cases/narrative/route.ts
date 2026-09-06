import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logError } from '@/lib/errors';
import { rateLimit } from '@/server/rate-limit';
import { MAX_NARRATIVE_CHARS, readNarrative } from '@/server/cases/read-narrative';

/**
 * Reading a user's account into structured factual assertions.
 *
 * The only endpoint in PCNWatch that receives prose somebody wrote about their
 * own life, so it is the one place where the privacy rules have to be visible
 * rather than inherited:
 *
 *  - The account is never persisted, never logged and never fingerprinted by
 *    content. It exists as a local variable for the duration of one request.
 *  - The response carries assertions only. The account is not echoed back, so
 *    it cannot end up in a browser cache, a proxy log or a screenshot of the
 *    network tab.
 *  - Nothing returned here is a fact yet. The user is shown each assertion and
 *    confirms it before any of it can influence an assessment; this endpoint
 *    has no route to `assessCase` at all.
 *
 * No validation error quotes the body. A message saying which part of the
 * account failed to parse would put the account in a log line.
 */

const bodySchema = z.object({
  narrative: z.string().max(MAX_NARRATIVE_CHARS),
});

export async function POST(request: Request) {
  // A model call on arbitrary user text is the most expensive thing an
  // anonymous caller can trigger here, and the tightest limit we run.
  const limited = await rateLimit(request, { key: 'case-narrative', limit: 8, windowSeconds: 300 });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, reason: 'RATE_LIMITED' as const },
      { status: 429, headers: { 'retry-after': String(limited.retryAfterSeconds) } },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    // Deliberately says nothing about the content — not even a length or an
    // excerpt. The failure is logged as a failure, not as a sample.
    logError('api.cases.narrative.validation', new Error('The account failed validation.'));
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  try {
    const result = await readNarrative(parsed.data.narrative);
    if (!result.ok) {
      return NextResponse.json(
        { ok: false, reason: result.reason },
        { status: result.reason === 'NOT_CONFIGURED' ? 200 : 503 },
      );
    }
    return NextResponse.json({ ok: true as const, assertions: result.assertions });
  } catch (error) {
    // The error is logged without context, because the only context available
    // here is the account itself.
    logError('api.cases.narrative', error);
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }
}
