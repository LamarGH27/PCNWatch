import { CONTRAVENTION_RECORDS } from './records/contraventions';
import {
  PRIVATE_PARKING_RECORDS,
  PROCEDURE_RECORDS,
  TRIBUNAL_RECORDS,
} from './records/procedures';
import { DISCRETIONARY_RECORDS, STATUTORY_GROUND_RECORDS } from './records/statutory-grounds';
import type { ReferenceCategory, ReferenceCitation, ReferenceRecord } from './types';

/**
 * The approved reference store.
 *
 * This is the ONLY place the product may cite from. The AI layer is given citations
 * drawn from here and its output is rejected if it cites anything else
 * (see src/server/ai/citation-guard.ts).
 *
 * Records live in version control rather than in a mutable table so that every
 * change to what the product asserts is reviewable in a diff.
 */

const ALL_RECORDS: readonly ReferenceRecord[] = [
  ...CONTRAVENTION_RECORDS,
  ...STATUTORY_GROUND_RECORDS,
  ...DISCRETIONARY_RECORDS,
  ...PROCEDURE_RECORDS,
  ...TRIBUNAL_RECORDS,
  ...PRIVATE_PARKING_RECORDS,
];

export class InvalidReferenceRecordError extends Error {
  constructor(key: string, problem: string) {
    super(`Invalid reference record "${key}": ${problem}`);
    this.name = 'InvalidReferenceRecordError';
  }
}

/** Structural validation. A record that fails is a build-time bug, not a runtime warning. */
function validate(records: readonly ReferenceRecord[]): void {
  const seen = new Set<string>();
  for (const r of records) {
    if (!r.key) throw new InvalidReferenceRecordError('(missing key)', 'key is required');
    const id = `${r.key}@${r.version}`;
    if (seen.has(id)) throw new InvalidReferenceRecordError(r.key, `duplicate key/version "${id}"`);
    seen.add(id);
    if (!r.sourceName.trim()) throw new InvalidReferenceRecordError(r.key, 'sourceName is required');
    if (!r.sourceLocation.trim()) {
      throw new InvalidReferenceRecordError(r.key, 'sourceLocation is required — a reviewer must be able to open it');
    }
    if (!r.summary.trim()) throw new InvalidReferenceRecordError(r.key, 'summary is required');
    if (r.reviewStatus === 'REVIEWED' && !r.reviewedAt) {
      throw new InvalidReferenceRecordError(r.key, 'a REVIEWED record must carry a reviewedAt date');
    }
    if (r.effectiveTo && r.effectiveTo < r.effectiveFrom) {
      throw new InvalidReferenceRecordError(r.key, 'effectiveTo precedes effectiveFrom');
    }
  }
}

validate(ALL_RECORDS);

const BY_KEY = new Map<string, ReferenceRecord>();
for (const r of ALL_RECORDS) {
  const existing = BY_KEY.get(r.key);
  if (!existing || r.version > existing.version) BY_KEY.set(r.key, r);
}

/** All records, latest version of each key. */
export function allReferences(): readonly ReferenceRecord[] {
  return [...BY_KEY.values()];
}

export function getReference(key: string): ReferenceRecord | undefined {
  return BY_KEY.get(key);
}

export function referencesByCategory(category: ReferenceCategory): readonly ReferenceRecord[] {
  return allReferences().filter((r) => r.category === category);
}

export function getContravention(code: string): ReferenceRecord | undefined {
  return getReference(`CONTRAVENTION-${normaliseContraventionCode(code)}`);
}

/**
 * Normalises a contravention code to its canonical two-digit form.
 * Codes may appear on notices with a letter suffix (e.g. "01a") identifying the
 * specific restriction; the suffix is preserved separately, never silently dropped.
 */
export function normaliseContraventionCode(raw: string): string {
  const match = /^\s*(\d{1,2})\s*([a-zA-Z]?)\s*$/.exec(raw);
  if (!match) return raw.trim();
  return (match[1] as string).padStart(2, '0');
}

export function contraventionSuffix(raw: string): string | null {
  const match = /^\s*\d{1,2}\s*([a-zA-Z])\s*$/.exec(raw);
  return match ? (match[1] as string).toLowerCase() : null;
}

export function toCitation(record: ReferenceRecord): ReferenceCitation {
  return {
    key: record.key,
    version: record.version,
    title: record.title,
    sourceName: record.sourceName,
    sourceLocation: record.sourceLocation,
    reviewStatus: record.reviewStatus,
  };
}

export function citationsFor(keys: readonly string[]): ReferenceCitation[] {
  const citations: ReferenceCitation[] = [];
  for (const key of keys) {
    const record = getReference(key);
    if (record) citations.push(toCitation(record));
  }
  return citations;
}

/** True when every supplied key exists in the store. Used to reject AI citations. */
export function allCitationsExist(keys: readonly string[]): boolean {
  return keys.every((k) => BY_KEY.has(k));
}

export function unknownCitations(keys: readonly string[]): string[] {
  return keys.filter((k) => !BY_KEY.has(k));
}

/**
 * Whether a reference-backed page may be indexed by search engines.
 *
 * A page whose content is still awaiting legal review is useful to a user who
 * arrived with that notice in hand, but publishing it for search traffic would be
 * asserting unverified legal content — so it is rendered `noindex` and kept out of
 * the sitemap until reviewed.
 */
export function isPubliclyIndexable(record: ReferenceRecord): boolean {
  return record.reviewStatus === 'REVIEWED';
}

export function indexableContraventions(): readonly ReferenceRecord[] {
  return referencesByCategory('CONTRAVENTION').filter(isPubliclyIndexable);
}

/** Every contravention code we hold a record for, sorted. */
export function knownContraventionCodes(): string[] {
  return referencesByCategory('CONTRAVENTION')
    .map((r) => String((r.content as { code?: string }).code ?? ''))
    .filter(Boolean)
    .sort();
}
