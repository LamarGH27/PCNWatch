import { runAiJob } from '@/server/ai/client';
import { CHALLENGE_DRAFT_SYSTEM, challengeDraftInstruction } from '@/server/ai/prompts';
import type { ChallengeDraft } from '@/server/ai/schemas';
import type { DefencePack, GroundedStatement } from '@/core/defence/types';
import { ASSESSMENT_ENGINE_VERSION } from '@/core/assessment/engine';

/**
 * The letter, drafted last.
 *
 * By the time this runs the Defence Pack already exists and every fact in it
 * has been through verification. The model is handed those facts and asked to
 * write them as a letter; it is not shown the case, it does not choose the
 * points, and it cannot introduce one. If it fails, the pack is still a pack —
 * the sections the user paid for are the deterministic ones, and the letter is
 * the part a model helps with.
 */

export interface DraftedChallenge {
  readonly subject: string;
  readonly body: string;
  readonly citedReferenceKeys: readonly string[];
  readonly factualAssertions: ChallengeDraft['factualAssertions'];
  readonly omittedBecauseUnsupported: readonly string[];
  readonly model: string;
  readonly promptVersion: string;
  readonly aiLogId: string | null;
}

export type DraftOutcome =
  | { readonly kind: 'DRAFTED'; readonly draft: DraftedChallenge }
  | {
      readonly kind: 'NOT_DRAFTED';
      /** Said to the user. Never the model's own words — see reasonFor. */
      readonly what: string;
      readonly whatYouCanDo: string;
    };

export const DEFENCE_PACK_ENGINE_VERSION = `defence-1.0.0+${ASSESSMENT_ENGINE_VERSION}`;

/**
 * Everything the letter is allowed to assert, flattened.
 *
 * Assembled from the pack rather than from the case, so a fact that did not
 * make it into a pack section cannot be quietly available to the drafter.
 */
export function establishedFacts(pack: DefencePack): GroundedStatement[] {
  const facts: GroundedStatement[] = [];

  const summary = pack.caseSummary;
  const push = (text: string | null, reference: string) => {
    if (text) facts.push({ text, source: 'VERIFIED_NOTICE_FACT', reference });
  };
  push(summary.pcnNumberMasked && `The notice number is on the letter head`, 'pcnNumber');
  push(summary.contraventionCode && `Contravention code ${summary.contraventionCode}`, 'contraventionCode');
  push(summary.incidentDate && `The alleged contravention is dated ${summary.incidentDate}`, 'incidentDate');
  push(summary.location && `The location on the notice is ${summary.location}`, 'location');
  push(summary.amount && `The amount demanded is ${summary.amount}`, 'fullAmountPence');

  for (const statement of pack.account.userSays) facts.push(statement);
  for (const item of pack.evidence.items) {
    for (const fact of item.verifiedFacts) {
      facts.push({ ...fact, text: `${item.label} — ${fact.text}` });
    }
  }
  for (const point of pack.factualPoints) {
    for (const ground of point.grounds) facts.push(ground);
  }

  // One entry per (reference, text). A model shown the same fact three times
  // tends to say it three times.
  const seen = new Set<string>();
  return facts.filter((fact) => {
    const key = `${fact.reference}::${fact.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function draftChallenge(
  pack: DefencePack,
  caseId: string,
): Promise<DraftOutcome> {
  const established = establishedFacts(pack);

  const result = await runAiJob({
    jobType: 'CHALLENGE_DRAFTING',
    system: CHALLENGE_DRAFT_SYSTEM,
    userContent: [
      {
        type: 'text',
        text: challengeDraftInstruction({
          caseSummary: {
            'Issuing authority': pack.caseSummary.authority ?? 'not confirmed',
            'Contravention code': pack.caseSummary.contraventionCode ?? 'not confirmed',
            Contravention: pack.caseSummary.contravention ?? 'not held',
            Location: pack.caseSummary.location ?? 'not confirmed',
            Date: pack.caseSummary.incidentDate ?? 'not confirmed',
            'Current stage': pack.caseSummary.stageLabel,
          },
          established: established.map((fact) => ({
            text: fact.text,
            supportedBy: supportedByFor(fact.source),
            reference: fact.reference,
          })),
          weaknesses: pack.weaknesses.map((w) => w.what),
          legalPosition: pack.legalPosition.explanation,
        }),
      },
    ],
    grounding: {
      permittedReferenceKeys: pack.permittedReferences.referenceKeys,
      verifiedCaseFields: pack.permittedReferences.verifiedCaseFields,
      availableEvidenceRefs: pack.permittedReferences.evidenceRefs,
      permittedNarrativeRefs: pack.permittedReferences.confirmedAssertions,
      /*
       * False for every case today: every statutory ground, contravention and
       * procedure record is PENDING_LEGAL_REVIEW. It is computed rather than
       * hardcoded so that a reviewer signing one off changes the answer without
       * anybody editing this line.
       */
      reviewedLegalMaterial: pack.legalPosition.canStateGrounds,
    },
    caseId,
  });

  if (!result.ok || !result.data) {
    return {
      kind: 'NOT_DRAFTED',
      /*
       * `result.errors` can quote the response, including a rejected sentence
       * that invented a statute. Putting that on the user's screen would show
       * them the fabrication as though it were their letter, so the wording
       * here is ours and the model's stays in the rejection log.
       */
      what:
        result.outcome === 'SCHEMA_REJECTED' || result.outcome === 'CITATION_REJECTED'
          ? 'We produced a draft letter and would not accept it.'
          : 'We could not produce the draft letter.',
      whatYouCanDo:
        'The rest of your Defence Pack is complete and unchanged, and any letter you already had is still here. You can ask us to try the letter again.',
    };
  }

  const draft = result.data as ChallengeDraft;
  return {
    kind: 'DRAFTED',
    draft: {
      subject: draft.subject,
      body: draft.body,
      citedReferenceKeys: draft.citedReferenceKeys,
      factualAssertions: draft.factualAssertions,
      omittedBecauseUnsupported: draft.omittedBecauseUnsupported,
      model: result.model,
      promptVersion: result.promptVersion,
      aiLogId: result.logId,
    },
  };
}

/** Our five-source provenance mapped onto the three the draft schema carries. */
function supportedByFor(source: GroundedStatement['source']): string {
  switch (source) {
    case 'CONFIRMED_USER_ASSERTION':
      return 'USER_NARRATIVE';
    case 'VERIFIED_EVIDENCE_FACT':
      return 'EVIDENCE_ITEM';
    default:
      return 'VERIFIED_CASE_FIELD';
  }
}
