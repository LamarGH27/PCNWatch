import { getContravention, getReference } from '../reference/store';
import { EVIDENCE_DEFINITIONS } from './definitions';
import type {
  EvidenceChecklist,
  EvidenceChecklistItem,
  EvidenceRequirement,
  EvidenceType,
} from './types';
import { EVIDENCE_TYPES } from './types';

/**
 * Builds the evidence checklist for a case.
 *
 * Requirements are derived from the approved reference store — the contravention
 * record and any grounds the user is asserting — not from a hardcoded list per
 * screen. An unknown contravention yields the baseline only, never a guess.
 */

export interface ChecklistInput {
  /** Canonical two-digit contravention code, or null when not yet known. */
  readonly contraventionCode: string | null;
  /** Ground reference keys the user is asserting, e.g. "GROUND-ALREADY_PAID". */
  readonly assertedGroundKeys?: readonly string[];
  /** Evidence already uploaded, by type. */
  readonly provided?: Partial<Record<EvidenceType, number>>;
}

const BASELINE: readonly EvidenceRequirement[] = [
  {
    type: 'PCN_IMAGE',
    importance: 'ESSENTIAL',
    reason: 'Every date and amount in your case is checked against the notice itself.',
    referenceKeys: [],
  },
  {
    type: 'COUNCIL_PHOTOGRAPHS',
    importance: 'STRONG',
    reason: 'These are the images the authority will rely on when it considers your challenge.',
    referenceKeys: [],
  },
];

function isEvidenceType(value: string): value is EvidenceType {
  return (EVIDENCE_TYPES as readonly string[]).includes(value);
}

function readEvidenceKeys(content: unknown): EvidenceType[] {
  const raw = (content as { relevantEvidence?: unknown } | null)?.relevantEvidence;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is EvidenceType => typeof v === 'string' && isEvidenceType(v));
}

export function buildEvidenceRequirements(input: ChecklistInput): EvidenceRequirement[] {
  // Highest importance wins when several sources ask for the same evidence type.
  const rank = { ESSENTIAL: 3, STRONG: 2, SUPPORTING: 1 } as const;
  const merged = new Map<EvidenceType, EvidenceRequirement>();

  const add = (req: EvidenceRequirement) => {
    const existing = merged.get(req.type);
    if (!existing) {
      merged.set(req.type, req);
      return;
    }
    merged.set(req.type, {
      type: req.type,
      importance: rank[req.importance] >= rank[existing.importance] ? req.importance : existing.importance,
      reason: existing.reason === req.reason ? existing.reason : `${existing.reason} ${req.reason}`,
      referenceKeys: Array.from(new Set([...existing.referenceKeys, ...req.referenceKeys])),
    });
  };

  for (const req of BASELINE) add(req);

  if (input.contraventionCode) {
    const record = getContravention(input.contraventionCode);
    if (record) {
      for (const type of readEvidenceKeys(record.content)) {
        add({
          type,
          importance: 'STRONG',
          reason: `Commonly relevant to contravention ${input.contraventionCode}.`,
          referenceKeys: [record.key],
        });
      }
    }
  }

  for (const groundKey of input.assertedGroundKeys ?? []) {
    const record = getReference(groundKey);
    if (!record) continue;
    for (const type of readEvidenceKeys(record.content)) {
      add({
        type,
        importance: 'ESSENTIAL',
        reason: `Needed to support the ground you are relying on: ${record.title.toLowerCase()}.`,
        referenceKeys: [record.key],
      });
    }
  }

  return [...merged.values()];
}

export function buildEvidenceChecklist(input: ChecklistInput): EvidenceChecklist {
  const requirements = buildEvidenceRequirements(input);
  const provided = input.provided ?? {};

  const order = { ESSENTIAL: 0, STRONG: 1, SUPPORTING: 2 } as const;
  const items: EvidenceChecklistItem[] = requirements
    .map((req) => {
      const itemCount = provided[req.type] ?? 0;
      return {
        ...req,
        definition: EVIDENCE_DEFINITIONS[req.type],
        provided: itemCount > 0,
        itemCount,
      };
    })
    .sort((a, b) => {
      const byImportance = order[a.importance] - order[b.importance];
      if (byImportance !== 0) return byImportance;
      // Outstanding items float above satisfied ones, then stable by type name.
      if (a.provided !== b.provided) return a.provided ? 1 : -1;
      return a.type.localeCompare(b.type);
    });

  return {
    items,
    missingEssential: items.filter((i) => i.importance === 'ESSENTIAL' && !i.provided).map((i) => i.type),
    missingStrong: items.filter((i) => i.importance === 'STRONG' && !i.provided).map((i) => i.type),
    providedCount: items.filter((i) => i.provided).length,
  };
}
