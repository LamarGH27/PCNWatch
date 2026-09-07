-- ---------------------------------------------------------------------------
-- Defence Pack persistence and staleness
-- ---------------------------------------------------------------------------
--
-- `pcn_drafts` has held a generated body, an edited body, citations, a model
-- and a prompt version since 0004. It has never been written to, because
-- nothing generated a draft. Two things are missing for a Defence Pack:
--
--   * the pack itself — the deterministic sections, which are what the user
--     actually paid for. The letter is one section of it;
--   * a way to tell whether the pack still describes the case.
--
-- The second matters more than it looks. A user generates a pack, then uploads
-- the authority's photographs, then prints the pack. Nothing about the document
-- would have said the case had moved on, and the section headed "weaknesses"
-- would still say the photographs were missing. So the inputs are fingerprinted
-- at generation and compared on every read.
--
-- Expand-only and idempotent, in the same style as 0014 and 0016. Nothing is
-- dropped and no existing column changes meaning, so it is safe to apply to a
-- Production database running the current code.

alter table pcn_drafts
  -- The deterministic pack. Regenerated from the record on demand, and stored
  -- so a reopened case shows the document the user actually had.
  add column if not exists pack jsonb,

  -- What the pack was built from. Two fingerprints rather than one because the
  -- user is told which half moved: "you have added evidence" is more useful
  -- than "something changed".
  add column if not exists case_fingerprint text,
  add column if not exists evidence_fingerprint text,

  -- Provenance of the letter half. `model` and `prompt_version` already exist.
  add column if not exists engine_version text,
  add column if not exists generated_at timestamptz not null default now(),

  -- Set when the user edits the letter. The generated body is never
  -- overwritten: an edit is a second opinion about wording, not a correction to
  -- the record, and losing the original would make a regeneration diff
  -- impossible to explain.
  add column if not exists edited_at timestamptz;

comment on column pcn_drafts.pack is
  'The deterministic Defence Pack sections, built from verified facts before any model was called. The letter in generated_body is drafted from this, never the other way round.';
comment on column pcn_drafts.case_fingerprint is
  'Fingerprint of the verified case facts and confirmed context at generation. A mismatch on read marks the pack stale rather than presenting it as current.';
comment on column pcn_drafts.evidence_fingerprint is
  'Fingerprint of the evidence that supported the case at generation. Changes when an item is added, verified, re-read or deleted.';
comment on column pcn_drafts.edited_body is
  'The user''s edited letter. Presentation only — it can never alter a case fact, an evidence fact or a finding.';

-- One current pack per case per kind. A regeneration replaces the row rather
-- than accumulating drafts nobody asked for, and `version` records how many
-- times it has been rebuilt.
create unique index if not exists pcn_drafts_case_kind_key
  on pcn_drafts (case_id, draft_kind);

create index if not exists pcn_drafts_user_idx on pcn_drafts (user_id);

-- Same reason as 0017: where the owner can come from the database, it should.
alter table pcn_drafts alter column user_id set default auth.uid();
