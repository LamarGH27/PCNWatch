import { queryRows } from '@/server/db/reader';
import { logError } from '@/lib/errors';

/**
 * Whether private document storage is actually safe to use.
 *
 * Migration 0006 cannot create the `storage.objects` policies on hosted
 * Supabase — the platform owns that table — so it attempts them, tolerates the
 * privilege error, and leaves the six policies to be created through the
 * dashboard. That means "the migration ran" says nothing about whether uploads
 * are safe.
 *
 * So readiness is read back from the catalogue instead of assumed. Until every
 * policy exists, one user's documents could be readable by another, and the
 * application must refuse uploads rather than create that exposure. A failure to
 * check is treated as not ready: the safe answer when we cannot tell is no.
 */
export interface StorageReadiness {
  readonly ready: boolean;
  readonly rlsEnabled: boolean;
  readonly bucketsPresent: number;
  readonly bucketsPrivate: boolean;
  readonly policiesPresent: number;
  readonly policiesExpected: number;
  readonly missing: readonly string[];
  /** Set when readiness could not be determined at all. */
  readonly checkFailed?: boolean;
}

const NOT_READY: StorageReadiness = {
  ready: false,
  rlsEnabled: false,
  bucketsPresent: 0,
  bucketsPrivate: false,
  policiesPresent: 0,
  policiesExpected: 6,
  missing: [],
  checkFailed: true,
};

export async function getStorageReadiness(): Promise<StorageReadiness> {
  const result = await queryRows<{
    ready: boolean;
    rls_enabled: boolean;
    buckets_present: number;
    buckets_private: boolean;
    policies_present: number;
    policies_expected: number;
    missing: string[] | null;
  }>('select * from pcnwatch_storage_readiness()');

  if (!result.ok) {
    logError('storage.readiness', new Error(result.reason));
    return NOT_READY;
  }

  const row = result.rows[0];
  if (!row) return NOT_READY;

  return {
    ready: row.ready === true,
    rlsEnabled: row.rls_enabled === true,
    bucketsPresent: Number(row.buckets_present ?? 0),
    bucketsPrivate: row.buckets_private === true,
    policiesPresent: Number(row.policies_present ?? 0),
    policiesExpected: Number(row.policies_expected ?? 6),
    missing: row.missing ?? [],
  };
}
