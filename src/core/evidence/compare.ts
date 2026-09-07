import { isIndependentEvidence } from '../context/reconcile';
import { EVIDENCE_FIELD_LABELS, type EvidenceField } from './analysis';
import { EVIDENCE_DEFINITIONS } from './definitions';
import type { VerifiedEvidenceFact } from './lifecycle';
import type { EvidenceType } from './types';

/**
 * Compares what the user's documents say against what their notice says.
 *
 * Deterministic, and narrow on purpose. It reads two strings that both went
 * through a human confirmation, decides whether they are the same thing, and
 * says so. It does not decide what the answer means.
 *
 * That restraint is the whole design. "The registration on this receipt is not
 * the registration on your notice" is a fact about two documents. "You paid for
 * the wrong car, so you have no defence" is a legal conclusion, and
 * "the registration matches, so the ticket is invalid" is a worse one — the
 * registration matching says nothing about whether the session covered the time,
 * the place, or the restriction that was actually enforced. A comparison never
 * becomes a defence, a ground, or a prediction, here or anywhere downstream.
 *
 * Fields with no honest comparison are reported as NOT_COMPARED rather than
 * guessed at. Whether "Bay 12, Tavistock Place" is the location on a notice
 * reading "TAVISTOCK PL O/S 40" is not something string comparison can answer,
 * and a product that answered it anyway would be inventing agreement or
 * inventing conflict, depending on the day.
 */

export type ComparisonOutcome = 'CONSISTENT' | 'DIFFERS' | 'NOT_COMPARED';

export interface EvidenceComparison {
  readonly evidenceId: string;
  readonly evidenceType: EvidenceType;
  readonly field: EvidenceField;
  readonly outcome: ComparisonOutcome;
  /** What the document says, as confirmed by the user. */
  readonly evidenceValue: string;
  /** What the notice says. Null when there is nothing to compare against. */
  readonly noticeValue: string | null;
  /** Neutral statement of the comparison. Never a conclusion. */
  readonly statement: string;
  /** True when the evidence is the authority's own material. */
  readonly independent: boolean;
}

/**
 * Said wherever comparisons are shown.
 *
 * Not decoration. A screen listing four green ticks is read as a verdict unless
 * something on it says otherwise.
 */
export const COMPARISON_CAUTION =
  'This compares what is written on your documents with what is written on your notice. ' +
  'It is not a view about whether your notice was correctly issued, whether you have a ' +
  'ground to rely on, or what an authority would decide.';

export interface NoticeFactsForComparison {
  readonly vehicleRegistration: string | null;
  readonly incidentDate: string | null;
  readonly incidentTime: string | null;
  readonly contraventionCode: string | null;
}

export interface ComparableEvidence {
  readonly id: string;
  readonly type: EvidenceType;
  readonly verifiedFacts: readonly VerifiedEvidenceFact[];
}

export function compareEvidence(
  items: readonly ComparableEvidence[],
  notice: NoticeFactsForComparison,
): readonly EvidenceComparison[] {
  const comparisons: EvidenceComparison[] = [];

  for (const item of items) {
    const label = EVIDENCE_DEFINITIONS[item.type]?.label ?? item.type;
    const independent = isIndependentEvidence(item.type);
    const valueOf = (field: EvidenceField) =>
      item.verifiedFacts.find((f) => f.field === field)?.value ?? null;

    const push = (
      field: EvidenceField,
      outcome: ComparisonOutcome,
      evidenceValue: string,
      noticeValue: string | null,
      statement: string,
    ) => {
      comparisons.push({
        evidenceId: item.id,
        evidenceType: item.type,
        field,
        outcome,
        evidenceValue,
        noticeValue,
        statement,
        independent,
      });
    };

    for (const fact of item.verifiedFacts) {
      if (!isComparableField(fact.field)) continue;
      const field = fact.field as EvidenceField;

      /* -- Registration ---------------------------------------------------- */

      if (field === 'VEHICLE_REGISTRATION') {
        const mine = normaliseRegistration(fact.value);
        const theirs = normaliseRegistration(notice.vehicleRegistration ?? '');
        if (mine === '' || theirs === '') {
          push(field, 'NOT_COMPARED', fact.value, notice.vehicleRegistration,
            `${label}: we have no confirmed registration on your notice to compare this against.`);
        } else if (mine === theirs) {
          push(field, 'CONSISTENT', fact.value, notice.vehicleRegistration,
            `${label}: the registration (${fact.value}) is the same as the one on your notice.`);
        } else {
          push(field, 'DIFFERS', fact.value, notice.vehicleRegistration,
            `${label}: the registration reads ${fact.value}, where your notice reads ${notice.vehicleRegistration}.`);
        }
        continue;
      }

      /* -- Date the document is about --------------------------------------- */

      if (field === 'DATE') {
        const mine = parseDate(fact.value);
        const theirs = parseDate(notice.incidentDate ?? '');
        if (!mine || !theirs) {
          push(field, 'NOT_COMPARED', fact.value, notice.incidentDate,
            `${label}: we could not read this date and the date on your notice in a form we can compare.`);
        } else if (mine === theirs) {
          push(field, 'CONSISTENT', fact.value, notice.incidentDate,
            `${label}: the date is the same day as the one on your notice.`);
        } else {
          push(field, 'DIFFERS', fact.value, notice.incidentDate,
            `${label}: this is dated ${mine}, where your notice says the contravention happened on ${theirs}.`);
        }
        continue;
      }

      /* -- Contravention code ----------------------------------------------- */

      if (field === 'CONTRAVENTION_CODE') {
        const mine = fact.value.trim().toUpperCase();
        const theirs = (notice.contraventionCode ?? '').trim().toUpperCase();
        if (mine === '' || theirs === '') {
          push(field, 'NOT_COMPARED', fact.value, notice.contraventionCode,
            `${label}: there is no confirmed contravention code on your case to compare this against.`);
        } else if (mine === theirs) {
          push(field, 'CONSISTENT', fact.value, notice.contraventionCode,
            `${label}: the contravention code is the same as the one on your case.`);
        } else {
          push(field, 'DIFFERS', fact.value, notice.contraventionCode,
            `${label}: the code reads ${fact.value}, where your case records ${notice.contraventionCode}.`);
        }
        continue;
      }
    }

    /* -- Paid period against the time on the notice ------------------------- */

    const from = valueOf('TIME_FROM');
    const to = valueOf('TIME_TO');
    const at = notice.incidentTime;
    if (from && at) {
      const start = parseTime(from);
      const end = to ? parseTime(to) : null;
      const moment = parseTime(at);
      if (!start || !moment) {
        push('TIME_FROM', 'NOT_COMPARED', from, at,
          `${label}: we could not read these times in a form we can compare.`);
      } else if (!end) {
        // A start with no confirmed end is not a window. Saying it "covers" the
        // time would mean assuming a duration nobody read off the document.
        push('TIME_FROM', 'NOT_COMPARED', from, at,
          `${label}: this shows a start time of ${from} but no end time we could read, so we cannot say whether it covered ${at}.`);
      } else if (moment >= start && moment <= end) {
        push('TIME_FROM', 'CONSISTENT', `${from}–${to}`, at,
          `${label}: the period ${from} to ${to} includes ${at}, the time on your notice.`);
      } else {
        push('TIME_FROM', 'DIFFERS', `${from}–${to}`, at,
          `${label}: the period ${from} to ${to} does not include ${at}, the time on your notice.`);
      }
    }

    /* -- Validity dates against the date on the notice ---------------------- */

    const validFrom = valueOf('VALID_FROM');
    const validTo = valueOf('VALID_TO');
    if ((validFrom || validTo) && notice.incidentDate) {
      const incident = parseDate(notice.incidentDate);
      const start = validFrom ? parseDate(validFrom) : null;
      const end = validTo ? parseDate(validTo) : null;
      const shown = [validFrom, validTo].filter(Boolean).join(' to ');
      if (!incident || (validFrom && !start) || (validTo && !end)) {
        push('VALID_TO', 'NOT_COMPARED', shown, notice.incidentDate,
          `${label}: we could not read these dates in a form we can compare.`);
      } else if ((start && incident < start) || (end && incident > end)) {
        push('VALID_TO', 'DIFFERS', shown, notice.incidentDate,
          `${label}: this shows ${shown}, which does not include ${incident}, the date on your notice.`);
      } else if (start && end) {
        push('VALID_TO', 'CONSISTENT', shown, notice.incidentDate,
          `${label}: ${incident}, the date on your notice, falls inside ${shown}.`);
      } else {
        // One end of the range only. It rules out a date on the wrong side and
        // nothing more, so the honest answer is that it is not settled.
        push('VALID_TO', 'NOT_COMPARED', shown, notice.incidentDate,
          `${label}: only one end of the validity period is readable, so we cannot say whether it covered ${incident}.`);
      }
    }
  }

  return comparisons;
}

/** Fields compared one-to-one against a notice field. */
function isComparableField(field: string): boolean {
  return field === 'VEHICLE_REGISTRATION' || field === 'DATE' || field === 'CONTRAVENTION_CODE';
}

/**
 * Registrations, compared the way a person would.
 *
 * Spacing on a UK plate is presentational and differs between a printed notice
 * and an app receipt. Nothing else is normalised: O and 0 are different
 * characters, and deciding they are the same would be correcting the user's
 * document to agree with their notice.
 */
export function normaliseRegistration(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * ISO or UK-order dates only.
 *
 * Anything else is not comparable. A date read as "11/08/26" could be two
 * different days depending on where it was printed, and picking one would be
 * guessing about the fact the comparison exists to check.
 */
export function parseDate(value: string): string | null {
  const trimmed = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (iso) return validDate(iso[1]!, iso[2]!, iso[3]!);
  const uk = /^(\d{1,2})[/. -](\d{1,2})[/. -](\d{4})$/.exec(trimmed);
  if (uk) return validDate(uk[3]!, uk[2]!.padStart(2, '0'), uk[1]!.padStart(2, '0'));
  return null;
}

function validDate(year: string, month: string, day: string): string | null {
  const date = `${year}-${month}-${day}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rejects 2026-02-30, which Date would roll forward into March.
  return parsed.toISOString().slice(0, 10) === date ? date : null;
}

/** Minutes since midnight, or null when it is not an unambiguous 24-hour time. */
export function parseTime(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export { EVIDENCE_FIELD_LABELS };
