import { createHash } from 'node:crypto';
import { supportsAssessment } from '@/core/evidence/lifecycle';
import type { CaseRecord } from '@/server/cases/case-view';

/**
 * What a Defence Pack was built from, reduced to two strings.
 *
 * A pack is a document about a case at a moment. The case then moves — the user
 * uploads the authority's photographs, confirms a reading, corrects a date —
 * and the document on their screen quietly stops being true. Nothing about it
 * would say so: the weaknesses section would still list the photographs as
 * missing, and they would print it and send it.
 *
 * So the inputs are fingerprinted at generation and compared on every read.
 * Two fingerprints rather than one because the user is told which half moved,
 * and "you have added evidence since this was written" is a more useful
 * sentence than "something changed".
 *
 * Only inputs the pack actually uses are included. `updated_at` is not: a case
 * touched by a save that changed nothing must not mark a good pack stale, and a
 * user told their document is out of date when it is not will stop believing
 * the warning the one time it matters.
 */

export interface Fingerprints {
  readonly caseFingerprint: string;
  readonly evidenceFingerprint: string;
}

export type Staleness =
  | { readonly stale: false }
  | {
      readonly stale: true;
      readonly caseChanged: boolean;
      readonly evidenceChanged: boolean;
      readonly message: string;
    };

function digest(parts: unknown): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

export function fingerprintCase(record: CaseRecord): Fingerprints {
  /*
   * Sorted at every level, because the fingerprint must describe the facts and
   * not the order Postgres happened to return them in. An unsorted array would
   * mark packs stale at random, which is the same as not warning at all.
   */
  const caseFingerprint = digest({
    pcnNumber: record.pcnNumber,
    authorityName: record.authorityName,
    authoritySlug: record.authoritySlug,
    noticeCategory: record.noticeCategory,
    contraventionCode: record.contraventionCode,
    contraventionSuffix: record.contraventionSuffix,
    incidentDate: record.incidentDate,
    incidentTime: record.incidentTime,
    issueDate: record.issueDate,
    locationText: record.locationText,
    vehicleRegistration: record.vehicleRegistration,
    fullAmountPence: record.fullAmountPence,
    discountedAmountPence: record.discountedAmountPence,
    discountDeadlinePrinted: record.discountDeadlinePrinted,
    representationDeadlinePrinted: record.representationDeadlinePrinted,
    proceduralStage: record.proceduralStage,
    narrativeProvided: record.narrativeProvided,
    verifiedFields: Object.entries(record.verifiedFields)
      .filter(([, v]) => v === true)
      .map(([k]) => k)
      .sort(),
    answers: [...record.contextAnswers]
      .map((a) => `${a.questionId}:${a.answer}`)
      .sort(),
    assertions: [...record.confirmedAssertions].map((a) => `${a.kind}:${a.stance}`).sort(),
    resolved: [...record.resolvedFacts].map((r) => `${r.topic}:${r.stance}`).sort(),
    declared: [...record.declaredEvidence].map((d) => `${d.type}:${d.held}`).sort(),
    grounds: [...record.assertedGroundKeys].sort(),
  });

  /*
   * Evidence that supports the case, and what it says.
   *
   * An item moving from UPLOADED to VERIFIED changes the pack, so status is in
   * here. So are the confirmed facts themselves: a user who re-reads a document
   * and confirms a different registration has changed the case materially, and
   * a fingerprint over ids alone would miss it entirely.
   */
  const evidenceFingerprint = digest(
    record.evidenceItems
      .map((item) => ({
        id: item.id,
        type: item.type,
        status: item.status,
        legibility: item.legibility,
        supporting: supportsAssessment(item),
        facts: item.verifiedFacts.map((f) => `${f.field}=${f.value}`).sort(),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );

  return { caseFingerprint, evidenceFingerprint };
}

export function checkStaleness(current: Fingerprints, stored: Partial<Fingerprints>): Staleness {
  const caseChanged = stored.caseFingerprint !== current.caseFingerprint;
  const evidenceChanged = stored.evidenceFingerprint !== current.evidenceFingerprint;
  if (!caseChanged && !evidenceChanged) return { stale: false };

  return {
    stale: true,
    caseChanged,
    evidenceChanged,
    message:
      caseChanged && evidenceChanged
        ? 'Your case details and your evidence have both changed since this Defence Pack was generated.'
        : caseChanged
          ? 'Your case details have changed since this Defence Pack was generated.'
          : 'Your evidence has changed since this Defence Pack was generated.',
  };
}
