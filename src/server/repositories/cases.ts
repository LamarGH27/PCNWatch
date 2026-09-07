import { createSupabaseServerClient } from '@/lib/supabase/server';
import { logError } from '@/lib/errors';
import type { CaseRecord } from '@/server/cases/case-view';
import { toEvidenceItem } from '@/server/evidence/store';
import type { ProceduralStage } from '@/core/reference/types';

/**
 * Reads a user's own case.
 *
 * Uses the request-scoped client, so RLS decides what is visible. There is no
 * ownership check in this file because there must not be one: relying on RLS
 * means a mistake here cannot expose another user's case, whereas an
 * application-level check could be forgotten on some future code path.
 */

export type CaseResult =
  | { readonly kind: 'FOUND'; readonly record: CaseRecord }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string };

export async function getCase(caseId: string): Promise<CaseResult> {
  if (!/^[0-9a-f-]{36}$/i.test(caseId)) return { kind: 'NOT_FOUND' };

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return { kind: 'UNAVAILABLE', correlationId: logError('cases.getCase', new Error('SUPABASE_NOT_CONFIGURED')) };
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { kind: 'NOT_SIGNED_IN' };

    const { data, error } = await supabase
      .from('pcn_cases')
      .select(
        `id, pcn_number, authority_name_raw, notice_category, contravention_code,
         contravention_suffix, incident_date, incident_time, issue_date, location_text,
         vehicle_registration_text,
         full_amount_pence, discounted_amount_pence, procedural_stage,
         discount_deadline_printed, representation_deadline_printed,
         narrative_provided, context_answers, confirmed_assertions, declared_evidence,
         resolved_facts, asserted_ground_keys, verified_fields, closed_at,
         authorities ( name, slug ),
         parking_locations ( slug ),
         pcn_evidence ( id, evidence_type, status, original_filename, content_type,
                        byte_size, legibility, analysis, verified_facts,
                        analysis_failure, analysis_attempts, created_at ),
         case_events ( event_type, to_stage, occurred_at )`,
      )
      .eq('id', caseId)
      .maybeSingle();

    if (error) throw error;
    // RLS returns no row for a case belonging to someone else, which is
    // indistinguishable from one that does not exist. That is intended.
    if (!data) return { kind: 'NOT_FOUND' };

    return { kind: 'FOUND', record: toCaseRecord(data) };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError('cases.getCase', error, { caseId }) };
  }
}

export async function listCases(): Promise<
  | { readonly kind: 'OK'; readonly cases: readonly CaseSummary[] }
  | { readonly kind: 'NOT_SIGNED_IN' }
  | { readonly kind: 'UNAVAILABLE'; readonly correlationId: string }
> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return {
      kind: 'UNAVAILABLE',
      correlationId: logError('cases.listCases', new Error('SUPABASE_NOT_CONFIGURED')),
    };
  }

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { kind: 'NOT_SIGNED_IN' };

    const { data, error } = await supabase
      .from('pcn_cases')
      .select(
        `id, pcn_number, location_text, procedural_stage, incident_date, closed_at,
         authority_name_raw, contravention_code, status, updated_at`,
      )
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    return {
      kind: 'OK',
      cases: (data ?? []).map((row) => ({
        id: String(row.id),
        pcnNumber: row.pcn_number ?? null,
        locationText: row.location_text ?? null,
        stage: row.procedural_stage as ProceduralStage,
        incidentDate: row.incident_date ?? null,
        closed: row.closed_at !== null,
        authorityName: row.authority_name_raw ?? null,
        contraventionCode: row.contravention_code ?? null,
        status: String(row.status ?? 'DRAFT'),
        updatedAt: String(row.updated_at ?? ''),
      })),
    };
  } catch (error) {
    return { kind: 'UNAVAILABLE', correlationId: logError('cases.listCases', error) };
  }
}

export interface CaseSummary {
  readonly id: string;
  readonly pcnNumber: string | null;
  readonly locationText: string | null;
  readonly stage: ProceduralStage;
  readonly incidentDate: string | null;
  readonly closed: boolean;
  readonly authorityName: string | null;
  readonly contraventionCode: string | null;
  readonly status: string;
  readonly updatedAt: string;
}

/* ------------------------------------------------------------------ */

type Row = Record<string, unknown>;

function toCaseRecord(row: Row): CaseRecord {
  const authority = firstOf(row.authorities) as { name?: string; slug?: string } | null;
  const location = firstOf(row.parking_locations) as { slug?: string } | null;

  /*
   * The evidence itself, not a tally of it.
   *
   * This used to count rows by type, which was the right shape for as long as
   * a row could only mean "a file exists". It now has to distinguish a claim
   * from an upload from a confirmed reading, and a count cannot: one number
   * would have to answer both "what have I given them?" and "what is actually
   * backing my case?", and the second answer is the smaller one.
   */
  const evidenceItems = asArray(row.pcn_evidence).map((item) =>
    toEvidenceItem(item as Record<string, unknown>),
  );

  // The dates that drive later-stage deadlines are recorded as case events rather
  // than columns, because a case can move through several of them.
  const events = asArray(row.case_events) as { to_stage?: string; occurred_at?: string }[];
  const stageDate = (stage: string) =>
    events.find((e) => e.to_stage === stage)?.occurred_at?.slice(0, 10) ?? null;

  return {
    id: String(row.id),
    pcnNumber: (row.pcn_number as string | null) ?? null,
    authorityName: authority?.name ?? ((row.authority_name_raw as string | null) ?? null),
    authoritySlug: authority?.slug ?? null,
    noticeCategory: (row.notice_category as CaseRecord['noticeCategory']) ?? 'UNKNOWN',
    contraventionCode: (row.contravention_code as string | null) ?? null,
    contraventionSuffix: (row.contravention_suffix as string | null) ?? null,
    incidentDate: (row.incident_date as string | null) ?? null,
    // Both confirmed off the notice by the user. Held so evidence can be
    // compared against them rather than against a value nobody checked.
    vehicleRegistration: (row.vehicle_registration_text as string | null) ?? null,
    incidentTime: timeOrNull(row.incident_time),
    issueDate: (row.issue_date as string | null) ?? null,
    noticeToOwnerServedDate: stageDate('NOTICE_TO_OWNER'),
    noticeOfRejectionServedDate: stageDate('NOTICE_OF_REJECTION'),
    locationText: (row.location_text as string | null) ?? null,
    // Read off the notice by the user. The only dates a saved case may show
    // without a reviewed rule behind them.
    discountDeadlinePrinted: isoDateOrNull(row.discount_deadline_printed),
    representationDeadlinePrinted: isoDateOrNull(row.representation_deadline_printed),
    parkingLocationSlug: location?.slug ?? null,
    fullAmountPence: numberOrNull(row.full_amount_pence),
    discountedAmountPence: numberOrNull(row.discounted_amount_pence),
    proceduralStage: (row.procedural_stage as ProceduralStage) ?? 'UNKNOWN_STAGE',
    // The account itself is never stored — migration 0014 dropped the column.
    // What survives is that one was written, which is all the engine reads.
    narrativeProvided: row.narrative_provided === true,
    contextAnswers: asArray(row.context_answers) as CaseRecord['contextAnswers'],
    confirmedAssertions: asArray(row.confirmed_assertions) as CaseRecord['confirmedAssertions'],
    declaredEvidence: asArray(row.declared_evidence) as CaseRecord['declaredEvidence'],
    resolvedFacts: asArray(row.resolved_facts) as CaseRecord['resolvedFacts'],
    assertedGroundKeys: Array.isArray(row.asserted_ground_keys)
      ? (row.asserted_ground_keys as string[])
      : [],
    verifiedFields: (row.verified_fields as Record<string, boolean>) ?? {},
    evidenceItems,
    closedAt: (row.closed_at as string | null) ?? null,
  };
}

function firstOf(value: unknown): unknown {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Postgres hands `time` back as HH:MM:SS; the comparison wants HH:MM. */
function timeOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{2}:\d{2})/.exec(value);
  return match ? match[1]! : null;
}

/** Postgres hands a date column back as a Date; the engines want the ISO day. */
function isoDateOrNull(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === 'string' && value !== '' ? value.slice(0, 10) : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
