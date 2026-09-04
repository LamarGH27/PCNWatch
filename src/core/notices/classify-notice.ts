import type { NoticeType } from '../reference/types';

/**
 * Deterministic notice classification.
 *
 * This runs BEFORE any model call and its result is authoritative for scope: a
 * private parking charge must never be pushed through local-authority PCN rules.
 * When the signals are ambiguous the answer is UNKNOWN and the user is asked —
 * guessing here would apply the wrong deadlines and the wrong statutory grounds.
 */

export type NoticeCategory = 'LOCAL_AUTHORITY_PCN' | 'PRIVATE_PARKING_CHARGE' | 'UNKNOWN';

export interface NoticeSignal {
  readonly pattern: string;
  readonly category: 'LOCAL_AUTHORITY_PCN' | 'PRIVATE_PARKING_CHARGE';
  readonly weight: number;
  readonly note: string;
}

/**
 * Signals are phrases that appear on the face of a notice. Weight 3 signals are
 * near-decisive; weight 1 signals are suggestive only.
 */
export const NOTICE_SIGNALS: readonly NoticeSignal[] = [
  // Local authority
  { pattern: 'traffic management act 2004', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'Cites the statute local authorities enforce under.' },
  { pattern: 'penalty charge notice', category: 'LOCAL_AUTHORITY_PCN', weight: 2, note: 'Statutory name for a local-authority notice.' },
  { pattern: 'london borough of', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'Issued by a London local authority.' },
  { pattern: 'notice to owner', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'A stage that exists only in the statutory process.' },
  { pattern: 'charge certificate', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'A stage that exists only in the statutory process.' },
  { pattern: 'london tribunals', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'The statutory appeal body for London councils.' },
  { pattern: 'environment and traffic adjudicator', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'The statutory adjudicator.' },
  { pattern: 'civil enforcement officer', category: 'LOCAL_AUTHORITY_PCN', weight: 2, note: 'Local-authority enforcement role.' },
  { pattern: 'traffic enforcement centre', category: 'LOCAL_AUTHORITY_PCN', weight: 3, note: 'Statutory recovery route.' },
  { pattern: 'contravention code', category: 'LOCAL_AUTHORITY_PCN', weight: 1, note: 'Uses the national contravention code list.' },

  // Private
  { pattern: 'parking charge notice', category: 'PRIVATE_PARKING_CHARGE', weight: 2, note: 'Wording typically used by private operators.' },
  { pattern: 'protection of freedoms act 2012', category: 'PRIVATE_PARKING_CHARGE', weight: 3, note: 'Keeper liability for private land.' },
  { pattern: 'schedule 4', category: 'PRIVATE_PARKING_CHARGE', weight: 1, note: 'Usually cited alongside the Protection of Freedoms Act.' },
  { pattern: 'popla', category: 'PRIVATE_PARKING_CHARGE', weight: 3, note: 'Private-sector appeals service.' },
  { pattern: 'independent appeals service', category: 'PRIVATE_PARKING_CHARGE', weight: 2, note: 'Private-sector appeals service.' },
  { pattern: 'british parking association', category: 'PRIVATE_PARKING_CHARGE', weight: 3, note: 'Private operator trade body.' },
  { pattern: 'international parking community', category: 'PRIVATE_PARKING_CHARGE', weight: 3, note: 'Private operator trade body.' },
  { pattern: 'breach of contract', category: 'PRIVATE_PARKING_CHARGE', weight: 2, note: 'Private charges are contractual, not statutory.' },
  { pattern: 'terms and conditions of parking', category: 'PRIVATE_PARKING_CHARGE', weight: 2, note: 'Contractual framing.' },
  { pattern: 'private land', category: 'PRIVATE_PARKING_CHARGE', weight: 2, note: 'Private land enforcement.' },
  { pattern: 'debt recovery', category: 'PRIVATE_PARKING_CHARGE', weight: 1, note: 'Private operators pursue charges as debts.' },
];

export interface NoticeClassification {
  readonly category: NoticeCategory;
  readonly noticeType: NoticeType;
  readonly confidence: number;
  readonly matchedSignals: readonly NoticeSignal[];
  /** Message to display when the notice is out of scope. */
  readonly outOfScopeMessage: string | null;
  readonly explanation: string;
}

/** Minimum weighted margin required before committing to a category. */
export const CLASSIFICATION_MARGIN = 3;

function normalise(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ');
}

/** Detects the specific statutory document type once a notice is known to be a council PCN. */
function localAuthorityNoticeType(haystack: string): NoticeType {
  if (haystack.includes('notice of rejection') || haystack.includes('rejection of representations')) {
    return 'NOTICE_OF_REJECTION';
  }
  if (haystack.includes('notice of acceptance') || haystack.includes('representations have been accepted')) {
    return 'NOTICE_OF_ACCEPTANCE';
  }
  if (haystack.includes('charge certificate')) return 'CHARGE_CERTIFICATE';
  if (haystack.includes('order for recovery')) return 'ORDER_FOR_RECOVERY';
  if (haystack.includes('notice to owner')) return 'NOTICE_TO_OWNER';
  if (haystack.includes('by post') || haystack.includes('camera') || haystack.includes('cctv')) {
    return 'PCN_POSTAL';
  }
  if (haystack.includes('penalty charge notice')) return 'PCN_ON_STREET';
  return 'UNKNOWN';
}

export const PRIVATE_PARKING_MESSAGE =
  'This version of FineRadar currently focuses on local-authority PCNs. Private parking charges follow a different process.';

export function classifyNotice(text: string): NoticeClassification {
  const haystack = normalise(text);
  const matched = NOTICE_SIGNALS.filter((s) => haystack.includes(s.pattern));

  let authority = 0;
  let priv = 0;
  for (const s of matched) {
    if (s.category === 'LOCAL_AUTHORITY_PCN') authority += s.weight;
    else priv += s.weight;
  }

  const margin = Math.abs(authority - priv);
  const total = authority + priv;

  if (total === 0 || margin < CLASSIFICATION_MARGIN) {
    return {
      category: 'UNKNOWN',
      noticeType: 'UNKNOWN',
      confidence: total === 0 ? 0 : Math.min(0.5, margin / CLASSIFICATION_MARGIN / 2),
      matchedSignals: matched,
      outOfScopeMessage: null,
      explanation:
        total === 0
          ? 'We could not find enough recognisable wording on this document to tell what kind of notice it is.'
          : 'This document contains wording associated with both local-authority and private parking notices, so we will not assume which it is.',
    };
  }

  if (priv > authority) {
    return {
      category: 'PRIVATE_PARKING_CHARGE',
      noticeType: 'PRIVATE_PARKING_CHARGE',
      confidence: Math.min(1, priv / (total || 1)),
      matchedSignals: matched,
      outOfScopeMessage: PRIVATE_PARKING_MESSAGE,
      explanation:
        'The wording on this document matches a private parking charge issued by an operator on private land, not a penalty charge notice issued by a council.',
    };
  }

  return {
    category: 'LOCAL_AUTHORITY_PCN',
    noticeType: localAuthorityNoticeType(haystack),
    confidence: Math.min(1, authority / (total || 1)),
    matchedSignals: matched,
    outOfScopeMessage: null,
    explanation: 'The wording on this document matches a penalty charge notice issued by a local authority.',
  };
}
