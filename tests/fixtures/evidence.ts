import type { EvidenceItem, EvidenceStatus } from '@/core/evidence/lifecycle';
import type { EvidenceType } from '@/core/evidence/types';

/**
 * An evidence item at whatever stage a test needs.
 *
 * Built stage by stage rather than from a single "provided: true" flag,
 * because the distinction between held and supporting is the thing most of
 * these tests exist to pin. A fixture that let a test say "there is a PCN
 * image" without saying how far it had got would let a regression through in
 * exactly the place it matters.
 */
export function evidenceItem(
  type: EvidenceType,
  status: EvidenceStatus,
  overrides: Partial<EvidenceItem> = {},
): EvidenceItem {
  const analysed = status === 'ANALYSED' || status === 'VERIFIED';
  return {
    id: `evidence-${type}-${status}`.toLowerCase(),
    type,
    status,
    originalFilename: 'photo.jpg',
    contentType: 'image/jpeg',
    byteSize: 120_000,
    legibility: analysed ? 'CLEAR' : null,
    analysis: analysed
      ? {
          legibility: 'CLEAR',
          observations: [
            { field: 'VEHICLE_REGISTRATION', value: 'AB12CDE', confidence: 0.94, status: 'READ' },
          ],
          unreadableRegions: [],
        }
      : null,
    verifiedFacts:
      status === 'VERIFIED' ? [{ field: 'VEHICLE_REGISTRATION', value: 'AB12CDE' }] : [],
    analysisFailure: null,
    analysisAttempts: analysed ? 1 : 0,
    createdAt: '2026-02-01T10:00:00.000Z',
    ...overrides,
  };
}
