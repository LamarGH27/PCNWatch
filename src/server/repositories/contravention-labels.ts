/**
 * What an authority calls a contravention code, for display only.
 *
 * This exists because the reviewed reference store does not cover Camden's data:
 * 30 of the 40 codes in a real ingestion have no reviewed record, and those
 * codes carry more than half of all notices. Without this a location page shows
 * "Code 33" and nothing else.
 *
 * **This is not legal content and must never be used as any.** It is the
 * publisher's own labelling of its own enforcement data, reproduced verbatim and
 * attributed to them. The approved reference store — read through
 * `getContravention` — remains the only source for the assessment engine, the
 * evidence checklist and the AI citation allow-list. Nothing in this module is
 * imported by any of those, and a test asserts it stays that way.
 */
import { queryRows } from '@/server/db/reader';
import { getContravention } from '@/core/reference/store';
import { logError } from '@/lib/errors';

export type ContraventionDescriptionSource = 'APPROVED_REFERENCE' | 'AUTHORITY_PUBLISHED';

export interface ContraventionDescription {
  readonly code: string;
  readonly text: string;
  readonly source: ContraventionDescriptionSource;
  /** Name to show alongside authority-published text. Null for the reference. */
  readonly attribution: string | null;
}

/**
 * Labels an authority published, keyed by code.
 *
 * Where an authority used more than one wording for a code, the one on the most
 * notices wins — but every variant is stored, so a rare wording is recoverable
 * rather than lost.
 */
export async function getAuthorityLabels(
  authoritySlug: string,
): Promise<ReadonlyMap<string, string>> {
  const result = await queryRows<{ code: string; description: string }>(
    `select l.code, l.description
       from authority_contravention_labels l
       join authorities a on a.id = l.authority_id
      where a.slug = $1
      order by l.code, l.event_count desc`,
    [authoritySlug],
  );

  if (!result.ok) {
    // A missing label is a worse page, not a wrong one, so this degrades to the
    // approved reference rather than failing the request.
    logError('contraventionLabels.get', new Error(result.reason), { authoritySlug });
    return new Map();
  }

  const labels = new Map<string, string>();
  for (const row of result.rows) {
    if (!labels.has(row.code)) labels.set(row.code, row.description);
  }
  return labels;
}

/**
 * The description to show for a code, and where it came from.
 *
 * The approved reference always wins. The authority's wording is a fallback, and
 * carries its attribution so a reader can tell the difference between "this is
 * what the law says" and "this is what Camden calls it".
 */
export function describeContravention(
  code: string,
  authorityLabels: ReadonlyMap<string, string>,
  authorityName: string,
): ContraventionDescription | null {
  const approved = getContravention(code);
  if (approved) {
    return { code, text: approved.summary, source: 'APPROVED_REFERENCE', attribution: null };
  }

  const published = authorityLabels.get(code);
  if (published) {
    return {
      code,
      text: published,
      source: 'AUTHORITY_PUBLISHED',
      attribution: authorityName,
    };
  }

  // Neither. The page says the code and nothing else, which is honest.
  return null;
}
