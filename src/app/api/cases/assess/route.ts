import { NextResponse } from 'next/server';
import { z } from 'zod';
import { logError } from '@/lib/errors';
import { rateLimit } from '@/server/rate-limit';
import { assessVerifiedNotice, type VerifiedFacts } from '@/server/cases/assess-verified';
import { NOTICE_TYPES } from '@/server/ai/schemas';
import { EVIDENCE_TYPES } from '@/core/evidence/types';
import type { UserContext } from '@/core/context/types';

/**
 * The free assessment for a set of confirmed facts.
 *
 * Runs on the server because the reference store and the rules engines live
 * there, not because anything is stored: this endpoint persists nothing. It
 * takes facts the user has confirmed and returns what the deterministic
 * engines make of them.
 *
 * No model is called. The contravention's meaning comes from the approved
 * reference store or is reported as absent; deadlines come from the deadline
 * engine or are refused. Neither is ever generated.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const optionalDate = z.string().regex(ISO_DATE).optional();

/**
 * Only confirmed facts are accepted.
 *
 * Every field is optional because the user may have marked any of them
 * unknown, and an absent field genuinely means "not established" — it is not a
 * missing parameter. What is not sent cannot reach a deadline or a finding.
 */
const bodySchema = z.object({
  authorityName: z.string().max(200).optional(),
  pcnNumber: z.string().max(64).optional(),
  vehicleRegistration: z.string().max(16).optional(),
  noticeType: z.enum(NOTICE_TYPES),
  contraventionCode: z.string().max(8).optional(),
  contraventionDescription: z.string().max(400).optional(),
  incidentDate: optionalDate,
  incidentTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  issueDate: optionalDate,
  location: z.string().max(300).optional(),
  fullAmountPence: z.number().int().min(0).max(1_000_000).optional(),
  discountedAmountPence: z.number().int().min(0).max(1_000_000).optional(),
  discountDeadlinePrinted: optionalDate,
  representationDeadlinePrinted: optionalDate,

  /*
   * What the user has told us about what happened.
   *
   * Note what is not here: the narrative itself. The account a user writes may
   * name a hospital, an employer, a child or an address, no rule in the
   * deterministic engine can read free prose, and there is no authenticated
   * place to put it yet — so the browser keeps the text and sends only the fact
   * that it exists. This endpoint cannot log, store or leak a sentence it never
   * receives.
   *
   * What does arrive is a closed set: question ids the reference store can
   * resolve, three possible answers, and evidence types from a fixed list.
   * Nothing free-form reaches a finding.
   */
  context: z
    .object({
      narrativeProvided: z.boolean(),
      answers: z
        .array(
          z.object({
            questionId: z.string().max(120),
            answer: z.enum(['YES', 'NO', 'UNSURE']),
          }),
        )
        .max(40)
        .default([]),
      declaredEvidence: z
        .array(
          z.object({
            type: z.enum(EVIDENCE_TYPES),
            held: z.enum(['HAVE', 'DO_NOT_HAVE', 'NOT_SURE']),
          }),
        )
        .max(40)
        .default([]),
    })
    .optional(),
});

export async function POST(request: Request) {
  const limited = await rateLimit(request, { key: 'case-assess', limit: 30, windowSeconds: 60 });
  if (!limited.allowed) {
    return NextResponse.json(
      { ok: false, reason: 'RATE_LIMITED' as const },
      { status: 429 },
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
    // The notice details are never logged — only that validation failed.
    logError('api.cases.assess.validation', new Error('Verified facts failed validation.'));
    return NextResponse.json({ ok: false, reason: 'BAD_REQUEST' as const }, { status: 400 });
  }

  try {
    const { context, ...facts } = parsed.data;
    return NextResponse.json({
      ok: true as const,
      assessment: assessVerifiedNotice(
        facts as VerifiedFacts,
        context as UserContext | undefined,
      ),
    });
  } catch (error) {
    logError('api.cases.assess', error);
    return NextResponse.json({ ok: false, reason: 'UNAVAILABLE' as const }, { status: 503 });
  }
}
