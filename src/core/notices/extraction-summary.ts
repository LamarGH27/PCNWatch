import { FIELD_VERIFICATION_THRESHOLD } from './verification-policy';

/**
 * One field the reader returned, and how much it can be trusted.
 *
 * Lives here rather than beside the extraction pipeline because the browser
 * needs it too: the compact summary is rendered client-side, and importing it
 * from the server module dragged `next/headers` into a client bundle. The
 * vocabulary is shared; the extraction that produces it is not.
 */
export interface ExtractedFieldView {
  readonly key: string;
  readonly label: string;
  readonly value: string | number | null;
  readonly confidence: number;
  readonly requiresVerification: boolean;
  readonly hint: string | null;
}

/**
 * The compact "we read your PCN" summary, and what it may confirm.
 *
 * The verification screen asked for up to fourteen individual ticks, and the
 * submit button stayed disabled until every one of them was made. That is a
 * defensible design and it is also why people stopped: nothing about a PCN
 * needs fourteen decisions from somebody standing next to their car.
 *
 * So the fast journey shows the values and asks one question — is this right?
 * That is a real confirmation rather than a shortcut past one, but only under a
 * condition this function exists to enforce:
 *
 *   a field may be confirmed by the summary ONLY if the summary displayed it.
 *
 * Confirming a value somebody was never shown is not confirmation, whatever the
 * button says. So `shown` is both the list rendered and the list the "Looks
 * right" action is permitted to confirm, and they cannot drift apart because
 * they are the same array.
 *
 * Anything the reader could not read, or read poorly, is not in `shown` at all.
 * Those stay individual checks in the fast journey exactly as before — the
 * screen shrinks for the ordinary case and does not shrink for the case where
 * shrinking would cost something.
 */
export interface ExtractionSummary {
  /**
   * Fields displayed in the summary, in reading order. Confirming the summary
   * confirms exactly these.
   */
  readonly shown: readonly ExtractedFieldView[];
  /**
   * Fields a person has to check individually: unreadable, or read with too
   * little confidence to put in front of somebody as though it were settled.
   */
  readonly mustCheck: readonly ExtractedFieldView[];
  /** True when one tap is genuinely all this notice needs. */
  readonly fastPathAvailable: boolean;
}

/**
 * The five things a person recognises their own ticket by, first.
 *
 * The rest are still displayed — everything `shown` contains is on screen —
 * but these lead, because somebody checking whether we read their notice
 * correctly looks at the authority and the amount, not at the notice number.
 */
export const SUMMARY_HEADLINE_FIELDS: readonly string[] = [
  'authorityName',
  'contraventionCode',
  'incidentDate',
  'fullAmountPence',
  'location',
];

export function summariseExtraction(
  fields: readonly ExtractedFieldView[],
): ExtractionSummary {
  const shown: ExtractedFieldView[] = [];
  const mustCheck: ExtractedFieldView[] = [];

  for (const field of fields) {
    /*
     * The split is on legibility, not importance.
     *
     * An ALWAYS_VERIFY field read clearly belongs in the summary: it is
     * displayed, the user looks at it, and saying "yes that is my notice"
     * confirms it. What cannot go in the summary is a field with no value or a
     * doubtful one, because there is nothing there for a person to agree with.
     */
    if (field.value === null || field.confidence < FIELD_VERIFICATION_THRESHOLD) {
      mustCheck.push(field);
    } else {
      shown.push(field);
    }
  }

  const rank = (field: ExtractedFieldView) => {
    const index = SUMMARY_HEADLINE_FIELDS.indexOf(field.key);
    return index === -1 ? SUMMARY_HEADLINE_FIELDS.length : index;
  };
  shown.sort((a, b) => rank(a) - rank(b) || fields.indexOf(a) - fields.indexOf(b));

  return {
    shown,
    mustCheck,
    // One tap is only offered when there is nothing left that needs a person.
    fastPathAvailable: mustCheck.length === 0 && shown.length > 0,
  };
}

/**
 * The keys the summary is allowed to confirm.
 *
 * Derived from what was shown, never from a separate list. A second list would
 * be a place for the two to disagree, and the way they would disagree is by
 * confirming something nobody saw.
 */
export function confirmableFromSummary(summary: ExtractionSummary): string[] {
  return summary.shown.map((field) => field.key);
}
