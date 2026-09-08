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
      /** Constraints for a retry. Our categories, never the rejected text. */
      readonly tighten: readonly string[];
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
  /*
   * The registration, when the user confirmed it.
   *
   * It was absent, and on the case this feature exists for — "I paid by app
   * but may have entered the wrong registration" — the registration is the
   * entire point. A model asked to write that letter without it either omits
   * the theory or reaches for a value it was not given.
   */
  push(
    summary.vehicleRegistration && `The vehicle registration on the notice is ${summary.vehicleRegistration}`,
    'vehicleRegistration',
  );
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

/**
 * What went wrong, in our words.
 *
 * A rejection can quote the response, including the fabricated sentence that
 * caused it. Feeding that back to the model would invite it to reuse the
 * phrasing, and it would put the fabrication one bug away from the user's
 * screen. So the retry is told the category and nothing else.
 */
function tightenFrom(errors: readonly string[]): string[] {
  const notes = new Set<string>();
  for (const error of errors) {
    if (/legally reviewed material|statute|regulation|ground|adjudicator|exemption|provision/i.test(error)) {
      notes.add(
        'Do not mention legislation, regulations, legal grounds, appeals in law, exemptions or what any tribunal has decided. Argue only the facts you were given.',
      );
    }
    if (/Cited references/i.test(error)) {
      notes.add('Return citedReferenceKeys as an empty list.');
    }
    if (/attributes|has not verified|not attached to this case/i.test(error)) {
      notes.add(
        'Every factualAssertion must use one of the exact reference identifiers in square brackets in the established facts. Do not invent one.',
      );
    }
    if (/guarantee|probability|invalid/i.test(error)) {
      notes.add(
        'Do not say the notice is invalid, and do not predict the outcome. Ask for reconsideration.',
      );
    }
  }
  return [...notes];
}

/**
 * One retry, and only one.
 *
 * The first draft is rejected by a guard often enough to matter — a model
 * writing a careful letter reaches for a legal frame naturally — and losing
 * the user's letter to one unlucky attempt is not acceptable in a paid
 * product. A second attempt told what category it tripped is cheap and
 * usually enough.
 *
 * Two is the limit. A third would be spending the user's money to arrive at
 * the same answer, and a guard that fires twice is telling us something the
 * prompt should fix rather than something to grind past.
 */
export const MAX_DRAFT_ATTEMPTS = 2;

export async function draftChallenge(
  pack: DefencePack,
  caseId: string,
): Promise<DraftOutcome> {
  let tighten: readonly string[] = [];
  let last: DraftOutcome | null = null;

  for (let attempt = 1; attempt <= MAX_DRAFT_ATTEMPTS; attempt += 1) {
    const outcome = await attemptDraft(pack, caseId, tighten);
    if (outcome.kind === 'DRAFTED') return outcome;
    last = outcome;
    tighten = outcome.tighten;
    // Nothing to tighten means the failure was not something a constraint
    // would fix — an outage, a schema break — so a second identical attempt
    // would only cost time.
    if (tighten.length === 0) break;
  }

  return last ?? {
    kind: 'NOT_DRAFTED',
    what: 'We could not produce the draft letter.',
    whatYouCanDo: 'The rest of your Defence Pack is complete. You can ask us to try the letter again.',
    tighten: [],
  };
}

async function attemptDraft(
  pack: DefencePack,
  caseId: string,
  tighten: readonly string[],
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
          /*
           * A flag, not the paragraph.
           *
           * `legalPosition.explanation` contains "the statutory grounds of
           * representation", which is the exact phrase the validator rejects
           * when nothing is reviewed. Passing it handed the model forbidden
           * wording in the middle of the case material and then threw away
           * every draft that repeated it.
           */
          mayCiteLaw: pack.legalPosition.canStateGrounds,
          citableReferenceKeys: pack.permittedReferences.referenceKeys,
          tighten,
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
    const nextTighten = tightenFrom(result.errors);
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
      tighten: nextTighten,
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
