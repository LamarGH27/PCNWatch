import { runAiJob } from '@/server/ai/client';
import { EVIDENCE_ANALYSIS_SYSTEM, evidenceAnalysisInstruction } from '@/server/ai/prompts';
import type { EvidenceAnalysis } from '@/core/evidence/analysis';
import { profileFor } from '@/core/evidence/profiles';
import { withinProfile } from '@/core/evidence/verification';
import type { EvidenceItem } from '@/core/evidence/lifecycle';
import {
  beginAnalysisAttempt,
  readEvidenceFile,
  recordAnalysis,
  recordAnalysisFailure,
} from './store';

/**
 * Reads one uploaded file and records what it says.
 *
 * The pipeline is the same one the narrative goes through, for the same reason:
 *
 *   uploaded file -> structured factual extraction -> user verification -> assessment
 *
 * and never `uploaded file -> judgement`. What comes back here is a set of
 * transcriptions against a closed vocabulary. It is written to the case as a
 * proposal, the item moves to ANALYSED, and it stops there. Nothing about the
 * user's position changes until a person has looked at the readings and said
 * they are right.
 */

export type AnalysisOutcome =
  | { readonly kind: 'ANALYSED'; readonly item: EvidenceItem }
  | { readonly kind: 'NOT_ANALYSABLE'; readonly item: EvidenceItem }
  | {
      readonly kind: 'FAILED';
      readonly what: string;
      readonly whatYouCanDo: string;
      readonly fileRetained: true;
      readonly item: EvidenceItem | null;
    }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string };

/**
 * How many times we will read the same file before saying so.
 *
 * A retry is the user's to ask for, not something this runs in a loop: a file
 * that failed twice is usually a file we cannot read, and quietly trying it a
 * third time spends their money and their time to arrive at the same answer.
 */
export const MAX_ANALYSIS_ATTEMPTS = 3;

export async function analyseEvidence(evidenceId: string): Promise<AnalysisOutcome> {
  const file = await readEvidenceFile(evidenceId);
  if (file.kind === 'NOT_FOUND') return { kind: 'NOT_FOUND' };
  if (file.kind === 'NOT_SIGNED_IN') return { kind: 'NOT_SIGNED_IN' };
  if (file.kind !== 'OK') {
    return file.kind === 'UNAVAILABLE'
      ? { kind: 'UNAVAILABLE', correlationId: file.correlationId }
      : { kind: 'NOT_FOUND' };
  }

  const { item, bytes, mediaType } = file.value;

  const profile = profileFor(item.type);
  if (!profile) return { kind: 'NOT_ANALYSABLE', item };

  if (item.analysisAttempts >= MAX_ANALYSIS_ATTEMPTS) {
    return {
      kind: 'FAILED',
      what: 'We have tried to read this file several times and cannot.',
      whatYouCanDo:
        'Your file is still on your case. A clearer photograph, taken square-on in good light, usually reads where a dark or angled one does not.',
      fileRetained: true,
      item,
    };
  }

  const attempts = item.analysisAttempts + 1;
  // Recorded before the call, so a request that dies mid-flight still counts.
  await beginAnalysisAttempt(evidenceId, attempts);

  const result = await runAiJob({
    jobType: 'EVIDENCE_ANALYSIS',
    system: EVIDENCE_ANALYSIS_SYSTEM,
    userContent: [
      { type: 'text', text: evidenceAnalysisInstruction(profile) },
      mediaType === 'application/pdf'
        ? { type: 'document', mediaType: 'application/pdf', data: bytes.toString('base64') }
        : { type: 'image', mediaType, data: bytes.toString('base64') },
    ],
    // Evidence readings cite nothing, so nothing may be cited. The fields the
    // reader is allowed to use are authorised here and enforced in validate.ts.
    grounding: {
      permittedReferenceKeys: [],
      permittedEvidenceFields: profile.fields,
    },
  });

  if (!result.ok || !result.data) {
    /*
     * What the user is told, and what they are not.
     *
     * `result.errors` can quote the response — including a reading that was
     * rejected for containing a conclusion, which would put the fabricated
     * sentence on the user's screen as though it were what their document
     * said. So the stored reason and the message are ours, written from the
     * outcome; the model's own words stay in the rejection log.
     */
    const reason = reasonFor(result.outcome);
    await recordAnalysisFailure(evidenceId, reason.stored, attempts);
    return {
      kind: 'FAILED',
      what: reason.what,
      whatYouCanDo: reason.whatYouCanDo,
      fileRetained: true,
      item,
    };
  }

  // Second line behind the validator, which rejects out-of-profile fields
  // outright. This catches an analysis that reached storage by some other
  // route, and costs nothing when the validator has already done its job.
  const analysis = withinProfile(item.type, result.data as EvidenceAnalysis);

  const stored = await recordAnalysis(evidenceId, {
    analysis,
    model: result.model,
    promptVersion: result.promptVersion,
    aiLogId: result.logId,
  });

  if (stored.kind === 'NOT_SIGNED_IN') return { kind: 'NOT_SIGNED_IN' };
  if (stored.kind === 'UNAVAILABLE') {
    return { kind: 'UNAVAILABLE', correlationId: stored.correlationId };
  }
  if (stored.kind !== 'OK') return { kind: 'NOT_FOUND' };

  return { kind: 'ANALYSED', item: stored.value };
}

function reasonFor(outcome: string): {
  stored: string;
  what: string;
  whatYouCanDo: string;
} {
  if (outcome === 'SCHEMA_REJECTED' || outcome === 'CITATION_REJECTED') {
    return {
      stored: `Reading rejected: ${outcome}.`,
      what: 'We read this file but would not accept what came back.',
      whatYouCanDo:
        'Your file is still on your case and nothing about your assessment has changed. You can ask us to try again.',
    };
  }
  return {
    stored: 'Reading failed before a response was accepted.',
    what: 'We could not read this file.',
    whatYouCanDo:
      'Your file is still on your case and nothing about your assessment has changed. You can ask us to try again.',
  };
}
