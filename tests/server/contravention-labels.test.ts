import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describeContravention } from '@/server/repositories/contravention-labels';
import { getContravention } from '@/core/reference/store';

const LABELS = new Map([
  ['33', 'Using a route restricted to certain vehicles local buses and cycles only'],
  ['12', 'Something Camden calls code 12'],
]);

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
}

describe('authority-published contravention labels', () => {
  it('fills the gap where no reviewed record exists', () => {
    // 30 of the 40 codes in a real Camden ingestion have no reviewed record,
    // and they carry more than half of all notices. Without this those pages
    // show "Code 33" and nothing else.
    expect(getContravention('33')).toBeUndefined();
    const described = describeContravention('33', LABELS, 'Camden');
    expect(described?.text).toContain('local buses and cycles');
    expect(described?.source).toBe('AUTHORITY_PUBLISHED');
    expect(described?.attribution).toBe('Camden');
  });

  it('never lets publisher wording displace the reviewed reference', () => {
    // Code 12 has a reviewed record AND a publisher label. The reviewed one
    // wins, or unreviewed text would sit where a legal explanation belongs.
    expect(getContravention('12')).toBeDefined();
    const described = describeContravention('12', LABELS, 'Camden');
    expect(described?.source).toBe('APPROVED_REFERENCE');
    expect(described?.text).not.toContain('Something Camden calls');
    expect(described?.attribution).toBeNull();
  });

  it('returns nothing rather than inventing a description', () => {
    // 52 is in Camden's data and in neither the reviewed store nor the labels.
    expect(describeContravention('52', new Map(), 'Camden')).toBeNull();
  });
});

describe('the legal path cannot reach publisher wording', () => {
  // The separation this whole module depends on. Asserted against the source of
  // the files themselves, because a future import is exactly how it would be
  // lost — quietly, and without any test failing.
  const LEGAL_MODULES = [
    '../../src/core/assessment/engine.ts',
    '../../src/core/evidence/checklist.ts',
    '../../src/core/reference/store.ts',
  ];

  it('is not imported by the assessment engine, the checklist or the reference store', () => {
    for (const path of LEGAL_MODULES) {
      expect(read(path)).not.toContain('contravention-labels');
      expect(read(path)).not.toContain('authority_contravention_labels');
    }
  });

  it('keeps the reviewed reference as the only table the AI allow-list reads', () => {
    // If this ever fails, unreviewed publisher text has become citable.
    const validation = read('../../src/server/ai/validate.ts');
    expect(validation).not.toContain('authority_contravention_labels');
    expect(validation).not.toContain('contravention-labels');
  });
});
