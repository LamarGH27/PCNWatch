import { randomUUID } from 'node:crypto';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import { getStorageReadiness } from '@/server/repositories/storage-readiness';
import {
  isEvidenceLegibility,
  isEvidenceStatus,
  type EvidenceAnalysisRecord,
  type EvidenceItem,
  type EvidenceStatus,
  type VerifiedEvidenceFact,
} from '@/core/evidence/lifecycle';
import { EVIDENCE_TYPES, type EvidenceType } from '@/core/evidence/types';
import type { EvidenceAnalysis } from '@/core/evidence/analysis';
import {
  evidenceObjectPath,
  validateUpload,
  type AcceptedMediaType,
  type UploadRejection,
} from './upload-validation';

/**
 * Evidence storage, through the user's own session.
 *
 * Every call here uses the request-scoped Supabase client, so RLS decides what
 * is visible and the storage object policies decide what can be written. There
 * is no ownership check in this file and there must not be one — the service
 * role never touches evidence, so a bug here cannot reach another user's case
 * or another user's files. A missing check would fail closed rather than open.
 *
 * The one thing that is checked explicitly is whether storage is safe to use at
 * all. Migration 0006 cannot create the `storage.objects` policies on hosted
 * Supabase, so "the migration ran" says nothing; until the catalogue reports
 * every policy present, an upload could land in a bucket where one user's
 * photographs are readable by another. So uploads refuse rather than create
 * that exposure, and the refusal says what is missing.
 */

export const EVIDENCE_BUCKET = 'pcn-evidence';

/**
 * Where in the upload an attempt got to.
 *
 * The first real upload in Preview failed with "Something went wrong while
 * saving your file", one correlation id, and a log line reading
 * `message: "[object Object]"`. Every stage below fails the same way from the
 * outside, so that told us the request had failed and nothing else — not
 * whether the case was ours, whether the bucket had taken the bytes, or whether
 * the row had been refused.
 *
 * So a failure now names its stage. It costs one field and it is the difference
 * between reading a log and guessing at one.
 */
export const UPLOAD_STAGES = [
  'OWNERSHIP',
  'STORAGE_READINESS',
  'STORAGE_UPLOAD',
  'ROW_INSERT',
  'CLEANUP',
] as const;

export type UploadStage = (typeof UPLOAD_STAGES)[number];

export type EvidenceOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'REJECTED'; readonly rejection: UploadRejection }
  | { readonly kind: 'STORAGE_NOT_READY'; readonly missing: readonly string[] }
  | {
      readonly kind: 'UNAVAILABLE';
      readonly correlationId: string;
      /** Which step failed. Absent for reads, which have only one. */
      readonly stage?: UploadStage;
    };

const ROW_COLUMNS =
  'id, evidence_type, status, original_filename, content_type, byte_size, legibility, ' +
  'analysis, verified_facts, analysis_failure, analysis_attempts, created_at';

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

export async function listEvidence(
  caseId: string,
): Promise<EvidenceOutcome<readonly EvidenceItem[]>> {
  const session = await sessionFor('evidence.list');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .select(ROW_COLUMNS)
      .eq('case_id', caseId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return { kind: 'OK', value: asRows(data).map(toEvidenceItem) };
  } catch (error) {
    return unavailable('evidence.list', error, { caseId });
  }
}

export async function getEvidence(evidenceId: string): Promise<EvidenceOutcome<EvidenceItem>> {
  const session = await sessionFor('evidence.get');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .select(ROW_COLUMNS)
      .eq('id', evidenceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };
    return { kind: 'OK', value: toEvidenceItem(asRow(data)) };
  } catch (error) {
    return unavailable('evidence.get', error, { evidenceId });
  }
}

/**
 * A short-lived URL so the user can see their own file.
 *
 * The bucket is private and stays private: there is no public URL for an
 * evidence object and no code path that creates one. A signed URL is minted
 * only to render a thumbnail back to the person who uploaded it, it expires in
 * five minutes, and it is generated with the user's own session — so a signed
 * URL cannot be produced for a file the caller could not already read.
 */
export async function signedEvidenceUrl(
  evidenceId: string,
): Promise<EvidenceOutcome<string>> {
  const session = await sessionFor('evidence.signedUrl');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .select('storage_path')
      .eq('id', evidenceId)
      .maybeSingle();
    if (error) throw error;
    const path = (data as { storage_path?: string } | null)?.storage_path;
    if (!path) return { kind: 'NOT_FOUND' };

    const signed = await session.value.supabase.storage
      .from(EVIDENCE_BUCKET)
      .createSignedUrl(path, 300);
    if (signed.error || !signed.data) throw signed.error ?? new Error('NO_SIGNED_URL');
    return { kind: 'OK', value: signed.data.signedUrl };
  } catch (error) {
    return unavailable('evidence.signedUrl', error, { evidenceId });
  }
}

export interface EvidenceFile {
  readonly item: EvidenceItem;
  readonly bytes: Buffer;
  readonly mediaType: AcceptedMediaType;
}

/** Fetches the file for a reading pass. Held in memory and never written to disk. */
export async function readEvidenceFile(
  evidenceId: string,
): Promise<EvidenceOutcome<EvidenceFile>> {
  const session = await sessionFor('evidence.read');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .select(`${ROW_COLUMNS}, storage_path`)
      .eq('id', evidenceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };

    const row = data as Record<string, unknown>;
    const path = row.storage_path as string | null;
    const mediaType = row.content_type as string | null;
    if (!path || !mediaType) return { kind: 'NOT_FOUND' };

    const download = await session.value.supabase.storage.from(EVIDENCE_BUCKET).download(path);
    if (download.error || !download.data) throw download.error ?? new Error('NO_OBJECT');

    return {
      kind: 'OK',
      value: {
        item: toEvidenceItem(row),
        bytes: Buffer.from(await download.data.arrayBuffer()),
        mediaType: mediaType as AcceptedMediaType,
      },
    };
  } catch (error) {
    return unavailable('evidence.read', error, { evidenceId });
  }
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

export interface UploadRequest {
  readonly caseId: string;
  readonly evidenceType: EvidenceType;
  readonly file: File;
}

export async function uploadEvidence(
  request: UploadRequest,
): Promise<EvidenceOutcome<EvidenceItem>> {
  if (!(EVIDENCE_TYPES as readonly string[]).includes(request.evidenceType)) {
    return { kind: 'NOT_FOUND' };
  }

  const validation = validateUpload(request.file);
  if (!validation.ok) return { kind: 'REJECTED', rejection: validation.rejection };

  const readiness = await getStorageReadiness();
  if (!readiness.ready) {
    return { kind: 'STORAGE_NOT_READY', missing: readiness.missing };
  }

  const session = await sessionFor('evidence.upload');
  if (session.kind !== 'OK') return session;
  const { supabase, userId } = session.value;

  let path: string | null = null;
  let stage: UploadStage = 'OWNERSHIP';
  try {
    /*
     * Ownership before bytes.
     *
     * RLS and the assert_case_belongs_to_user trigger would both reject the row
     * for somebody else's case, but only after the object had been written.
     * Reading the case first means a request aimed at a case the caller does
     * not own never puts a file in the bucket at all.
     */
    const { data: owned, error: ownedError } = await supabase
      .from('pcn_cases')
      .select('id')
      .eq('id', request.caseId)
      .maybeSingle();
    if (ownedError) throw ownedError;
    if (!owned) return { kind: 'NOT_FOUND' };

    stage = 'STORAGE_UPLOAD';
    path = evidenceObjectPath(userId, request.caseId, validation.mediaType, randomUUID());

    const upload = await supabase.storage
      .from(EVIDENCE_BUCKET)
      .upload(path, request.file, { contentType: validation.mediaType, upsert: false });
    if (upload.error) throw upload.error;

    stage = 'ROW_INSERT';
    const { data, error } = await supabase
      .from('pcn_evidence')
      .insert({
        case_id: request.caseId,
        /*
         * The owner, from the session that was just verified.
         *
         * Omitting this is what broke the first real upload. `pcn_cases` takes
         * its owner from a column default added in 0014, so the save endpoint
         * correctly sends no user_id — and this file was written in that shape
         * without noticing that `pcn_evidence.user_id` never got the same
         * default. RLS then evaluated `with check (user_id = auth.uid())` as
         * `NULL = uuid`, which is NULL rather than true, and refused the row
         * with 42501 before the NOT NULL constraint was ever reached.
         *
         * Sending it does not make this endpoint trusted with the answer.
         * `userId` comes from `supabase.auth.getUser()`, which verifies the
         * session against the auth server rather than decoding a cookie, and
         * the same RLS check plus `assert_case_belongs_to_user` reject any
         * other value — a crafted request gets 42501 exactly as before.
         * Migration 0017 adds the default as well, so an insert that omits the
         * column again gets the right owner instead of this failure.
         */
        user_id: userId,
        evidence_type: request.evidenceType,
        status: 'UPLOADED' satisfies EvidenceStatus,
        storage_path: path,
        // Kept so the user recognises their own file. Never used to address
        // anything, and truncated because it is attacker-controlled text.
        original_filename: request.file.name.slice(0, 200),
        content_type: validation.mediaType,
        byte_size: request.file.size,
      })
      .select(ROW_COLUMNS)
      .single();
    if (error) throw error;

    return { kind: 'OK', value: toEvidenceItem(asRow(data)) };
  } catch (error) {
    /*
     * Nothing half-saved.
     *
     * A stored object with no row is unreachable and undeletable by its owner:
     * nothing lists it, the evidence page cannot show it, and the delete button
     * it would need does not exist. The row is the only handle on the object,
     * so if the row does not exist the object must not either.
     *
     * Only reached from STORAGE_UPLOAD onwards, because `path` is null until
     * then — an ownership failure has nothing to clean up.
     */
    if (path) await removeObject(supabase, path, request.caseId);
    return unavailable('evidence.upload', error, { caseId: request.caseId, stage });
  }
}

export async function deleteEvidence(evidenceId: string): Promise<EvidenceOutcome<null>> {
  const session = await sessionFor('evidence.delete');
  if (session.kind !== 'OK') return session;
  const { supabase } = session.value;

  try {
    // Deleted through the user's own session, so RLS returns nothing for a row
    // that is not theirs and the delete simply matches nothing.
    const { data, error } = await supabase
      .from('pcn_evidence')
      .delete()
      .eq('id', evidenceId)
      .select('storage_path')
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };

    const path = (data as { storage_path?: string | null }).storage_path;
    if (path) await removeObject(supabase, path);
    return { kind: 'OK', value: null };
  } catch (error) {
    return unavailable('evidence.delete', error, { evidenceId });
  }
}

export interface AnalysisRecord {
  readonly analysis: EvidenceAnalysis;
  readonly model: string;
  readonly promptVersion: string;
  readonly aiLogId: string | null;
}

/** Promotes UPLOADED to ANALYSED. Never to VERIFIED — only a person does that. */
export async function recordAnalysis(
  evidenceId: string,
  record: AnalysisRecord,
): Promise<EvidenceOutcome<EvidenceItem>> {
  const session = await sessionFor('evidence.recordAnalysis');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .update({
        status: 'ANALYSED' satisfies EvidenceStatus,
        analysis: record.analysis,
        legibility: record.analysis.legibility,
        analysis_model: record.model,
        analysis_prompt_version: record.promptVersion,
        analysis_ai_log_id: record.aiLogId,
        analysed_at: new Date().toISOString(),
        // A reading that worked clears the previous failure but keeps the
        // attempt count, so a document that needed three tries still says so.
        analysis_failure: null,
        // Readings changed, so anything confirmed against the old ones is void.
        verified_facts: null,
        verified_at: null,
      })
      .eq('id', evidenceId)
      .select(ROW_COLUMNS)
      .single();
    if (error) throw error;
    return { kind: 'OK', value: toEvidenceItem(asRow(data)) };
  } catch (error) {
    return unavailable('evidence.recordAnalysis', error, { evidenceId });
  }
}

/**
 * Records that a reading pass failed.
 *
 * The file is kept and the status is left where it was. A failure is a thing
 * that happened to us, not to the user's evidence: they gave us a document, we
 * could not read it, and losing their upload over that would be charging them
 * for our problem. Nothing about the assessment moves either — a failed pass
 * produces no readings, so there is nothing to confirm and nothing to count.
 */
export async function recordAnalysisFailure(
  evidenceId: string,
  reason: string,
  attempts: number,
): Promise<EvidenceOutcome<EvidenceItem>> {
  const session = await sessionFor('evidence.recordFailure');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .update({
        // Deliberately not the model's own words about the file. See analyse.ts.
        analysis_failure: reason.slice(0, 300),
        analysis_attempts: attempts,
      })
      .eq('id', evidenceId)
      .select(ROW_COLUMNS)
      .single();
    if (error) throw error;
    return { kind: 'OK', value: toEvidenceItem(asRow(data)) };
  } catch (error) {
    return unavailable('evidence.recordFailure', error, { evidenceId });
  }
}

export async function beginAnalysisAttempt(
  evidenceId: string,
  attempts: number,
): Promise<void> {
  const session = await sessionFor('evidence.beginAttempt');
  if (session.kind !== 'OK') return;
  await session.value.supabase
    .from('pcn_evidence')
    .update({ analysis_attempts: attempts })
    .eq('id', evidenceId);
}

/** Promotes ANALYSED to VERIFIED with the readings the user confirmed. */
export async function recordVerification(
  evidenceId: string,
  facts: readonly VerifiedEvidenceFact[],
): Promise<EvidenceOutcome<EvidenceItem>> {
  const session = await sessionFor('evidence.recordVerification');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value.supabase
      .from('pcn_evidence')
      .update({
        status: 'VERIFIED' satisfies EvidenceStatus,
        verified_facts: facts,
        verified_at: new Date().toISOString(),
      })
      .eq('id', evidenceId)
      // Only from ANALYSED. A caller cannot verify an item nothing has read,
      // and cannot skip the reading pass by posting confirmations at an upload.
      .eq('status', 'ANALYSED')
      .select(ROW_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };
    return { kind: 'OK', value: toEvidenceItem(asRow(data)) };
  } catch (error) {
    return unavailable('evidence.recordVerification', error, { evidenceId });
  }
}

/* ------------------------------------------------------------------ */

type Supabase = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

async function sessionFor(
  scope: string,
): Promise<EvidenceOutcome<{ supabase: Supabase; userId: string }>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError(scope, new Error('SUPABASE_NOT_CONFIGURED')),
    };
  }
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { kind: 'NOT_SIGNED_IN' };
    return { kind: 'OK', value: { supabase, userId: user.id } };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError(scope, error) };
  }
}

async function removeObject(
  supabase: Supabase,
  path: string,
  caseId?: string,
): Promise<void> {
  try {
    const { error } = await supabase.storage.from(EVIDENCE_BUCKET).remove([path]);
    // The client reports a failed removal in `error` rather than throwing, so
    // an unchecked call would report success for an object still in the bucket.
    if (error) throw error;
  } catch (error) {
    // The row is gone or was never written, so the object is orphaned rather
    // than exposed — it stays inside the owner's own prefix and no policy lets
    // anyone else read it. Logged so it can be swept, without the path itself.
    logError('evidence.removeObject', error, { caseId, stage: 'CLEANUP' satisfies UploadStage });
  }
}

function unavailable(
  scope: string,
  error: unknown,
  context: { caseId?: string; evidenceId?: string; stage?: UploadStage },
): EvidenceOutcome<never> {
  /*
   * Ids and a stage. Never a filename, a PCN number, a registration, a reading
   * or a storage path — the path embeds the user and case ids, which are
   * already here as fields, and adds nothing a log needs.
   */
  return {
    kind: 'UNAVAILABLE',
    correlationId: logError(scope, error, context),
    stage: context.stage,
  };
}

/*
 * The select list is assembled from a constant, which the Supabase client
 * cannot read statically, so it types the result as an error shape. These two
 * helpers narrow it in one place rather than scattering casts through every
 * query.
 */
function asRow(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

export function toEvidenceItem(row: Record<string, unknown>): EvidenceItem {
  const status = isEvidenceStatus(row.status) ? row.status : 'DECLARED';
  return {
    id: String(row.id),
    type: row.evidence_type as EvidenceType,
    status,
    originalFilename: (row.original_filename as string | null) ?? null,
    contentType: (row.content_type as string | null) ?? null,
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : null,
    legibility: isEvidenceLegibility(row.legibility) ? row.legibility : null,
    analysis: toAnalysisRecord(row.analysis),
    verifiedFacts: toVerifiedFacts(row.verified_facts),
    analysisFailure: (row.analysis_failure as string | null) ?? null,
    analysisAttempts: typeof row.analysis_attempts === 'number' ? row.analysis_attempts : 0,
    createdAt: row.created_at ? String(row.created_at) : null,
  };
}

/**
 * Rebuilds a stored analysis, dropping anything that no longer fits.
 *
 * `analysis` is jsonb written by an earlier version of this code against an
 * earlier vocabulary. A field that has since been removed must not travel back
 * out as a reading the user is asked to confirm, so the shape is checked on the
 * way out rather than trusted because we wrote it.
 */
function toAnalysisRecord(value: unknown): EvidenceAnalysisRecord | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as { legibility?: unknown; observations?: unknown; unreadableRegions?: unknown };
  if (!isEvidenceLegibility(record.legibility)) return null;
  const observations = Array.isArray(record.observations) ? record.observations : [];
  return {
    legibility: record.legibility,
    observations: observations.flatMap((entry) => {
      const o = entry as Record<string, unknown>;
      if (typeof o.field !== 'string' || typeof o.value !== 'string') return [];
      if (o.status !== 'READ' && o.status !== 'UNREADABLE') return [];
      return [
        {
          field: o.field,
          value: o.value,
          confidence: typeof o.confidence === 'number' ? o.confidence : 0,
          status: o.status,
        },
      ];
    }),
    unreadableRegions: Array.isArray(record.unreadableRegions)
      ? record.unreadableRegions.filter((r): r is string => typeof r === 'string')
      : [],
  };
}

function toVerifiedFacts(value: unknown): readonly VerifiedEvidenceFact[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const fact = entry as Record<string, unknown>;
    if (typeof fact.field !== 'string' || typeof fact.value !== 'string') return [];
    return [{ field: fact.field, value: fact.value }];
  });
}
