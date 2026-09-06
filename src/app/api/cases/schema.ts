import { z } from 'zod';
import { NOTICE_TYPES } from '@/server/ai/schemas';
import { EVIDENCE_TYPES } from '@/core/evidence/types';
import {
  ANSWER_VALUES,
  NARRATIVE_ASSERTION_KINDS,
  NARRATIVE_STANCES,
} from '@/core/context/types';

/**
 * The wire shape of a case, shared by saving and assessing.
 *
 * One definition because the two endpoints must agree about what a case is. If
 * they drifted, a case could be saveable but not assessable, or worse the other
 * way round — accepted for assessment in a shape that could never be written
 * down, so the user's work would vanish on refresh with no error to explain it.
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
export const caseFieldsSchema = z.object({
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
            answer: z.enum(ANSWER_VALUES),
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

      /*
       * Facts read out of the user's account that the user then confirmed.
       *
       * Note what this accepts: a kind and a stance, both from closed lists.
       * Not a summary, not a confidence, not a flag saying "confirmed: true".
       * A caller cannot send an unconfirmed assertion here because there is no
       * way to express one — the confirmed and unconfirmed forms are different
       * shapes, and only the confirmed shape has a route to the engine.
       *
       * The model's own words never travel this way either. Summaries are for
       * the confirmation screen; what reaches the assessment is which fact was
       * confirmed, in our vocabulary, and nothing the model wrote.
       */
      confirmedAssertions: z
        .array(
          z.object({
            kind: z.enum(NARRATIVE_ASSERTION_KINDS),
            stance: z.enum(NARRATIVE_STANCES),
          }),
        )
        .max(20)
        .default([]),

      /*
       * Contradictions the user has settled.
       *
       * A resolution overrides both original sources for its topic. It is
       * accepted here rather than being applied in the browser because the
       * refusal below is server-side: a client that resolved a conflict only in
       * its own state would keep being turned away, which is the correct
       * behaviour and would be a confusing bug if resolutions had nowhere to go.
       */
      resolvedFacts: z
        .array(
          z.object({
            topic: z.enum(NARRATIVE_ASSERTION_KINDS),
            stance: z.enum(NARRATIVE_STANCES),
          }),
        )
        .max(20)
        .default([]),
    })
    .optional(),
});

/** The same shape, plus the id of a case being updated rather than created. */
export const caseBodySchema = caseFieldsSchema.extend({
  /**
   * Present when the user is revising a case they already saved.
   *
   * Absent means create. A caller supplying an id they do not own gets the same
   * answer as one supplying an id that does not exist, because RLS matches no
   * row for either and the endpoint does not look closer.
   */
  caseId: z.string().uuid().optional(),
});
