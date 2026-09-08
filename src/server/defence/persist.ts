import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import { packStatusFor, type DefencePack, type PackStatus } from '@/core/defence/types';
import type { DraftedChallenge } from './generate';
import { checkStaleness, type Fingerprints, type Staleness } from './fingerprint';

/**
 * The stored Defence Pack.
 *
 * One row per case, through the user's own session, so RLS decides what exists.
 * There is no ownership check in this file and there must not be one: changing
 * a case id in the URL returns nothing because the policy matches nothing, not
 * because a comparison in application code happened to run.
 */

export interface StoredPack {
  readonly id: string;
  /**
   * Whether this is a finished deliverable.
   *
   * Derived on read from what is actually stored rather than trusted from a
   * column, so a row whose letter is empty cannot present itself as complete
   * however it came to be written.
   */
  readonly status: PackStatus;
  readonly pack: DefencePack;
  readonly subject: string;
  /** What the model wrote. Never overwritten by an edit. */
  readonly generatedBody: string;
  /** What the user made of it. Presentation only. */
  readonly editedBody: string | null;
  readonly citations: readonly string[];
  readonly model: string | null;
  readonly promptVersion: string | null;
  readonly engineVersion: string | null;
  readonly version: number;
  readonly generatedAt: string | null;
  readonly editedAt: string | null;
  readonly staleness: Staleness;
}

export type PackOutcome<T> =
  | { readonly kind: 'OK'; readonly value: T }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string };

const COLUMNS =
  'id, pack, generated_body, edited_body, citations, model, prompt_version, ' +
  'engine_version, version, generated_at, edited_at, case_fingerprint, evidence_fingerprint';

const DRAFT_KIND = 'DEFENCE_PACK';

export async function loadPack(
  caseId: string,
  current: Fingerprints,
): Promise<PackOutcome<StoredPack | null>> {
  const session = await session_('defence.load');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value
      .from('pcn_drafts')
      .select(COLUMNS)
      .eq('case_id', caseId)
      .eq('draft_kind', DRAFT_KIND)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'OK', value: null };

    return { kind: 'OK', value: toStoredPack(asRow(data), current) };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError('defence.load', error, { caseId }) };
  }
}

export interface SaveInput {
  readonly caseId: string;
  readonly pack: DefencePack;
  readonly draft: DraftedChallenge | null;
  readonly fingerprints: Fingerprints;
  readonly engineVersion: string;
  readonly previousVersion: number;
}

/**
 * Writes a pack, replacing the one before it.
 *
 * A half-generated document is never stored: the caller only reaches this once
 * the deterministic pack is complete, and a failed letter is written as an
 * empty body with the pack intact rather than as a partial letter that reads
 * like a finished one.
 */
export async function savePack(input: SaveInput): Promise<PackOutcome<StoredPack>> {
  const session = await session_('defence.save');
  if (session.kind !== 'OK') return session;

  try {
    const row = {
      case_id: input.caseId,
      draft_kind: DRAFT_KIND,
      pack: input.pack as unknown as Record<string, unknown>,
      generated_body: input.draft?.body ?? '',
      citations: input.draft?.citedReferenceKeys ?? [],
      model: input.draft?.model ?? null,
      prompt_version: input.draft?.promptVersion ?? null,
      ai_log_id: input.draft?.aiLogId ?? null,
      engine_version: input.engineVersion,
      case_fingerprint: input.fingerprints.caseFingerprint,
      evidence_fingerprint: input.fingerprints.evidenceFingerprint,
      version: input.previousVersion + 1,
      generated_at: new Date().toISOString(),
      /*
       * A regeneration drops the previous edit.
       *
       * The alternative is worse: silently keeping an edit written about an
       * older set of facts, on top of a pack rebuilt from newer ones. The user
       * is told this before they regenerate.
       */
      edited_body: null,
      edited_at: null,
    };

    const { data, error } = await session.value
      .from('pcn_drafts')
      .upsert(row, { onConflict: 'case_id,draft_kind' })
      .select(COLUMNS)
      .single();
    if (error) throw error;

    return { kind: 'OK', value: toStoredPack(asRow(data), input.fingerprints) };
  } catch (error) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError('defence.save', error, { caseId: input.caseId }),
    };
  }
}

/**
 * The user's edited letter.
 *
 * Writes exactly one column. That is the whole guarantee of section 7: an edit
 * cannot reach a case fact, an evidence fact or a finding, because this is the
 * only path an edit travels and there is nothing else on it. `pack` is not in
 * the update, so the authoritative half of the document is not merely
 * protected by convention — it is not addressable from here.
 */
export async function saveEditedBody(
  packId: string,
  body: string,
): Promise<PackOutcome<StoredPack>> {
  const session = await session_('defence.edit');
  if (session.kind !== 'OK') return session;

  try {
    const { data, error } = await session.value
      .from('pcn_drafts')
      .update({ edited_body: body, edited_at: new Date().toISOString() })
      .eq('id', packId)
      .select(COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };

    const row = asRow(data);
    return {
      kind: 'OK',
      value: toStoredPack(row, {
        caseFingerprint: String(row.case_fingerprint ?? ''),
        evidenceFingerprint: String(row.evidence_fingerprint ?? ''),
      }),
    };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError('defence.edit', error, { packId }) };
  }
}

/* ------------------------------------------------------------------ */

type Supabase = NonNullable<Awaited<ReturnType<typeof createSupabaseServerClient>>>;

async function session_(scope: string): Promise<PackOutcome<Supabase>> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError(scope, new Error('SUPABASE_NOT_CONFIGURED')),
    };
  }
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { kind: 'NOT_SIGNED_IN' };
  return { kind: 'OK', value: supabase };
}

function asRow(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

function toStoredPack(row: Record<string, unknown>, current: Fingerprints): StoredPack {
  const generatedBody = String(row.generated_body ?? '');
  return {
    id: String(row.id),
    status: packStatusFor({
      packBuilt: row.pack !== null && row.pack !== undefined,
      letterDrafted: generatedBody.trim() !== '',
    }),
    pack: row.pack as DefencePack,
    subject: '',
    generatedBody: String(row.generated_body ?? ''),
    editedBody: (row.edited_body as string | null) ?? null,
    citations: Array.isArray(row.citations) ? (row.citations as string[]) : [],
    model: (row.model as string | null) ?? null,
    promptVersion: (row.prompt_version as string | null) ?? null,
    engineVersion: (row.engine_version as string | null) ?? null,
    version: typeof row.version === 'number' ? row.version : 1,
    generatedAt: row.generated_at ? String(row.generated_at) : null,
    editedAt: row.edited_at ? String(row.edited_at) : null,
    staleness: checkStaleness(current, {
      caseFingerprint: (row.case_fingerprint as string | undefined) ?? undefined,
      evidenceFingerprint: (row.evidence_fingerprint as string | undefined) ?? undefined,
    }),
  };
}
