import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import type { VerifiedFacts } from '@/server/cases/assess-verified';
import { EMPTY_USER_CONTEXT, type UserContext } from '@/core/context/types';
import { classifyAuthorityName } from '@/core/notices/classify-authority';
import { stageForNoticeType } from '@/core/case/stage-from-notice';
import { normaliseContraventionCode } from '@/core/reference/store';

/**
 * Saving a case, and rebuilding one.
 *
 * What is stored is the *input* to an assessment, never the assessment. Verified
 * notice facts and the canonical context are what the user established; the
 * findings, the deadlines and the evidence ranking are a pure function of those
 * plus the approved reference store, so they are recomputed on every read.
 * Storing them instead would freeze a reference version and an engine version
 * into a row and create a second source of truth that could disagree with the
 * first — and the one that disagreed would be the one the user was looking at.
 *
 * Two things are deliberately absent from everything below.
 *
 * The account itself. `user_narrative` was dropped in migration 0014; what is
 * kept is that an account exists, which is all the engine consumes. The words
 * stay in the browser for the session.
 *
 * Unconfirmed readings. Only assertions the user looked at and accepted are
 * written — the row has no shape that could hold an extraction nobody confirmed,
 * and no column that could hold the model's summary of one.
 */

export type SaveResult =
  | { readonly kind: 'SAVED'; readonly caseId: string }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string };

export interface StoredCase {
  readonly id: string;
  readonly facts: VerifiedFacts;
  readonly context: UserContext;
  readonly status: string;
  readonly updatedAt: string;
}

/** Columns the case round-trip reads. Named once so the two paths cannot drift. */
const CASE_COLUMNS = `
  id, pcn_number, vehicle_registration_text, authority_name_raw, notice_type,
  contravention_code, contravention_description, incident_date, incident_time,
  issue_date, location_text, full_amount_pence, discounted_amount_pence,
  discount_deadline_printed, representation_deadline_printed,
  narrative_provided, context_answers, confirmed_assertions, declared_evidence,
  resolved_facts, status, context_revision, updated_at
`;

/**
 * Creates or updates the user's case from what they have confirmed.
 *
 * `user_id` is never sent. The column defaults to `auth.uid()` and RLS checks
 * the same value, so the owner is decided by the database from the caller's own
 * session — there is no code path here that could attribute a case to the wrong
 * person, because there is no code path here that names a person at all.
 */
export async function saveCase(
  facts: VerifiedFacts,
  context: UserContext,
  existingCaseId?: string,
): Promise<SaveResult> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError('cases.saveCase', new Error('SUPABASE_NOT_CONFIGURED')),
    };
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { kind: 'NOT_SIGNED_IN' };

    const row = toCaseRow(facts, context);

    if (existingCaseId) {
      if (!isUuid(existingCaseId)) return { kind: 'NOT_SIGNED_IN' };
      const { data, error } = await supabase
        .from('pcn_cases')
        .update(row)
        .eq('id', existingCaseId)
        .select('id')
        .maybeSingle();
      if (error) throw error;
      // RLS returns no row for someone else's case, which is the same answer as
      // for a case that does not exist. An update that matched nothing creates
      // nothing: silently inserting instead would let a guessed id become a new
      // case under a different owner's URL.
      if (!data) return { kind: 'NOT_SIGNED_IN' };
      return { kind: 'SAVED', caseId: String(data.id) };
    }

    const { data, error } = await supabase
      .from('pcn_cases')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;
    return { kind: 'SAVED', caseId: String(data.id) };
  } catch (error) {
    // No notice detail in the log line — not the number, the registration, the
    // location or the amount. Only that a save failed.
    return { kind: 'UNAVAILABLE', correlationId: logError('cases.saveCase', error) };
  }
}

/** Records that an assessment was produced, without storing it. */
export async function markAssessed(caseId: string): Promise<void> {
  if (!isUuid(caseId)) return;
  const supabase = await createSupabaseServerClient();
  if (!supabase) return;
  try {
    await supabase
      .from('pcn_cases')
      .update({ status: 'ASSESSED', last_assessed_at: new Date().toISOString() })
      .eq('id', caseId);
  } catch (error) {
    // A case that is saved but not marked assessed is a cosmetic problem. It
    // must never cost the user the assessment they are looking at.
    logError('cases.markAssessed', error);
  }
}

export type LoadResult =
  | { readonly kind: 'FOUND'; readonly stored: StoredCase }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string };

/**
 * Rebuilds a case's inputs.
 *
 * No ownership check here, deliberately. RLS decides, so someone else's case is
 * indistinguishable from one that does not exist — and an application-level
 * check is a thing a future code path can forget to write.
 */
export async function loadCase(caseId: string): Promise<LoadResult> {
  if (!isUuid(caseId)) return { kind: 'NOT_FOUND' };

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError('cases.loadCase', new Error('SUPABASE_NOT_CONFIGURED')),
    };
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { kind: 'NOT_SIGNED_IN' };

    const { data, error } = await supabase
      .from('pcn_cases')
      .select(CASE_COLUMNS)
      .eq('id', caseId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { kind: 'NOT_FOUND' };

    return { kind: 'FOUND', stored: fromCaseRow(data as Record<string, unknown>) };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError('cases.loadCase', error, { caseId }) };
  }
}

/* ------------------------------------------------------------------ */
/* Row mapping                                                         */
/* ------------------------------------------------------------------ */

/**
 * The row a set of confirmed facts becomes.
 *
 * Exported so the round-trip can be tested without a database, and so what is
 * written is inspectable in one place rather than spread across a query.
 */
export function toCaseRow(facts: VerifiedFacts, context: UserContext): Record<string, unknown> {
  const authority = classifyAuthorityName(facts.authorityName);

  return {
    pcn_number: facts.pcnNumber ?? null,
    vehicle_registration_text: facts.vehicleRegistration ?? null,
    authority_name_raw: facts.authorityName ?? null,
    notice_type: facts.noticeType,
    // Derived rather than sent, so the stored classification and the one the
    // assessment uses come from the same function.
    notice_category:
      facts.noticeType === 'PRIVATE_PARKING_CHARGE' || authority.kind === 'PRIVATE_OPERATOR'
        ? 'PRIVATE_PARKING_CHARGE'
        : authority.kind === 'LOCAL_AUTHORITY' || facts.noticeType !== 'UNKNOWN'
          ? 'LOCAL_AUTHORITY_PCN'
          : 'UNKNOWN',
    procedural_stage: stageForNoticeType(facts.noticeType),
    contravention_code: facts.contraventionCode
      ? normaliseContraventionCode(facts.contraventionCode)
      : null,
    contravention_description: facts.contraventionDescription ?? null,
    incident_date: facts.incidentDate ?? null,
    incident_time: facts.incidentTime ?? null,
    issue_date: facts.issueDate ?? null,
    location_text: facts.location ?? null,
    full_amount_pence: facts.fullAmountPence ?? null,
    discounted_amount_pence: facts.discountedAmountPence ?? null,
    discount_deadline_printed: facts.discountDeadlinePrinted ?? null,
    representation_deadline_printed: facts.representationDeadlinePrinted ?? null,

    // The account's existence, never the account.
    narrative_provided: context.narrativeProvided,
    context_answers: context.answers,
    confirmed_assertions: context.confirmedAssertions,
    declared_evidence: context.declaredEvidence,
    resolved_facts: context.resolvedFacts,

    // Which fields the user ticked. Read back by the assessment to decide what
    // it is allowed to treat as established.
    verified_fields: verifiedFieldsOf(facts),
    status: 'VERIFIED',
  };
}

/** The inverse. What comes back must produce the same assessment as what went in. */
export function fromCaseRow(row: Record<string, unknown>): StoredCase {
  const text = (key: string) => {
    const value = row[key];
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
  };
  const num = (key: string) => {
    const value = row[key];
    return typeof value === 'number' ? value : undefined;
  };
  const list = <T>(key: string): readonly T[] => {
    const value = row[key];
    return Array.isArray(value) ? (value as T[]) : [];
  };

  return {
    id: String(row.id),
    status: String(row.status ?? 'DRAFT'),
    updatedAt: String(row.updated_at ?? ''),
    facts: {
      noticeType: (row.notice_type as VerifiedFacts['noticeType']) ?? 'UNKNOWN',
      authorityName: text('authority_name_raw'),
      pcnNumber: text('pcn_number'),
      vehicleRegistration: text('vehicle_registration_text'),
      contraventionCode: text('contravention_code'),
      contraventionDescription: text('contravention_description'),
      incidentDate: text('incident_date'),
      // Postgres returns a time as HH:MM:SS; the engine expects HH:MM.
      incidentTime: text('incident_time')?.slice(0, 5),
      issueDate: text('issue_date'),
      location: text('location_text'),
      fullAmountPence: num('full_amount_pence'),
      discountedAmountPence: num('discounted_amount_pence'),
      discountDeadlinePrinted: text('discount_deadline_printed'),
      representationDeadlinePrinted: text('representation_deadline_printed'),
    },
    context: {
      ...EMPTY_USER_CONTEXT,
      narrativeProvided: row.narrative_provided === true,
      answers: list('context_answers'),
      declaredEvidence: list('declared_evidence'),
      confirmedAssertions: list('confirmed_assertions'),
      resolvedFacts: list('resolved_facts'),
    },
  };
}

/**
 * Which fields the user confirmed.
 *
 * Derived from presence: `collectVerifiedFacts` in the browser already drops
 * anything the user did not tick, so a field that arrived is one they confirmed.
 * Recording it separately means a later read knows the difference between "not
 * on the notice" and "never checked".
 */
function verifiedFieldsOf(facts: VerifiedFacts): Record<string, boolean> {
  return {
    pcnNumber: facts.pcnNumber !== undefined,
    contraventionCode: facts.contraventionCode !== undefined,
    incidentDate: facts.incidentDate !== undefined,
    location: facts.location !== undefined,
    fullAmountPence: facts.fullAmountPence !== undefined,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
