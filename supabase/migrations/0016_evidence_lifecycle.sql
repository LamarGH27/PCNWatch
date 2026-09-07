-- ---------------------------------------------------------------------------
-- Evidence lifecycle and analysis
-- ---------------------------------------------------------------------------
--
-- `pcn_evidence` has existed since 0004 as a place to record a file. What it
-- could not record is the only thing that matters about a piece of evidence:
-- how far it has got. A row said a permit existed; it could not say whether we
-- held the file, whether anything had read it, or whether the user had agreed
-- that what we read was right.
--
-- Those four states are different and must stay different, because each one
-- means something different for the user's case:
--
--   DECLARED  the user says this exists. We have not seen it. It is a claim.
--   UPLOADED  we hold the file. Nobody has read it. It supports nothing yet.
--   ANALYSED  something has read it and produced readings the user has not
--             confirmed. A model's reading is a proposal, never a fact.
--   VERIFIED  the user has confirmed the readings. Only now may anything from
--             this document reach the deterministic assessment.
--
-- Collapsing any two of those is the failure mode this table is shaped to
-- prevent: a product that counts an unread upload as support tells someone
-- their case is evidenced when nobody, human or otherwise, has looked at it.
--
-- Expand-only, in the same style as 0014. Nothing is dropped and every
-- statement is idempotent, so it is safe to apply to a Production database
-- running the current code — every column added here is unread by it.

do $$
begin
  if not exists (select 1 from pg_type where typname = 'evidence_status') then
    create type evidence_status as enum ('DECLARED', 'UPLOADED', 'ANALYSED', 'VERIFIED');
  end if;
end;
$$;

alter table pcn_evidence
  add column if not exists status evidence_status not null default 'DECLARED',

  -- What a reading pass produced. Structured observations against a closed
  -- field vocabulary — never prose, never a conclusion. See
  -- src/core/evidence/analysis.ts for the shape and why it is closed.
  add column if not exists analysis jsonb,
  add column if not exists analysis_model text,
  add column if not exists analysis_prompt_version text,
  add column if not exists analysis_ai_log_id uuid,
  add column if not exists analysed_at timestamptz,

  -- How legible the file was. Recorded separately from the readings because
  -- "we could not read this" has to survive independently of whether any
  -- individual field came back: an unreadable photograph must never improve
  -- the evidence basis, and that check needs somewhere to look.
  add column if not exists legibility text,

  -- Set when a reading pass failed. The file is kept and the item stays at
  -- UPLOADED so the user can retry; a failure never advances the lifecycle and
  -- never touches the assessment.
  add column if not exists analysis_failure text,
  add column if not exists analysis_attempts integer not null default 0,

  -- The readings the user actually confirmed, and nothing else. This column,
  -- not `analysis`, is what the assessment engine is allowed to read.
  add column if not exists verified_facts jsonb,
  add column if not exists verified_at timestamptz;

comment on column pcn_evidence.status is
  'DECLARED (claimed, unseen) -> UPLOADED (held, unread) -> ANALYSED (read, unconfirmed) -> VERIFIED (confirmed by the user). Only VERIFIED may support an assessment.';
comment on column pcn_evidence.analysis is
  'Structured readings from the analysis pass, against a closed field vocabulary. A proposal for the user to confirm, never a fact.';
comment on column pcn_evidence.verified_facts is
  'The readings the user confirmed. The only part of an evidence item the deterministic engine may read.';
comment on column pcn_evidence.legibility is
  'CLEAR, PARTIAL or UNREADABLE. An UNREADABLE item never improves the evidence basis however confident the reading was.';
comment on column pcn_evidence.analysis_failure is
  'Why the last reading pass failed. The file is retained and the item stays UPLOADED so it can be retried.';

-- Legibility is a small closed vocabulary. A check rather than an enum so a
-- future value can be added without a type migration on a hot table.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pcn_evidence_legibility_known'
  ) then
    alter table pcn_evidence
      add constraint pcn_evidence_legibility_known
      check (legibility is null or legibility in ('CLEAR', 'PARTIAL', 'UNREADABLE'));
  end if;
end;
$$;

-- A held file is what separates DECLARED from everything after it. Enforced
-- here so no code path can record an upload it does not actually have.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pcn_evidence_held_has_file'
  ) then
    alter table pcn_evidence
      add constraint pcn_evidence_held_has_file
      check (status = 'DECLARED' or storage_path is not null);
  end if;
end;
$$;

-- Two rows pointing at one object would let a delete orphan a live row, or a
-- second case borrow another's file. Partial, because DECLARED rows have no path.
create unique index if not exists pcn_evidence_storage_path_key
  on pcn_evidence (storage_path)
  where storage_path is not null;

create index if not exists pcn_evidence_case_status_idx
  on pcn_evidence (case_id, status);
