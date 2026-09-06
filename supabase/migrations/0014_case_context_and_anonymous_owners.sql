-- Case persistence for the analyse journey, and the end of the narrative column.
--
-- Until now nothing in the product wrote a case: the journey ran entirely in the
-- browser and was lost on refresh. This adds the columns needed to rebuild a
-- case from what the user confirmed, and removes the one column that must never
-- be written.
--
-- The RLS model is deliberately untouched. `pcn_cases` already carries
-- `user_id uuid not null references auth.users(id)` with a policy of
-- `for all to authenticated using (user_id = auth.uid())`, and a Supabase
-- anonymous user is a real row in `auth.users` holding the `authenticated`
-- role — so anonymous ownership works under the existing policy without
-- weakening it. Nothing here grants anything to `anon`.

-- ---------------------------------------------------------------------------
-- 1. The user's own words are no longer storable
-- ---------------------------------------------------------------------------

-- `user_narrative` was defined in 0004 and never written to. The product now
-- deliberately keeps the account in the browser: it may name a hospital, a
-- child, an employer or an illness, no deterministic rule can read prose, and
-- the assessment needs only to know that an account exists.
--
-- Dropping the column rather than documenting a rule about it is the point. A
-- column that must never be written is one `insert` away from being written,
-- and a privacy boundary enforced by the schema cannot be forgotten by a future
-- code path. What replaces it records the only thing the engine consumes.
alter table pcn_cases drop column if exists user_narrative;

alter table pcn_cases
  add column if not exists narrative_provided boolean not null default false;

comment on column pcn_cases.narrative_provided is
  'Whether the user wrote an account. The account itself is never stored: it stays in the browser for the session. See 0014.';

-- ---------------------------------------------------------------------------
-- 2. The canonical context the assessment is rebuilt from
-- ---------------------------------------------------------------------------

-- Stored as jsonb rather than as child tables because these are small, always
-- read together, always written together, and never queried across cases. A
-- table per shape would buy nothing and cost four joins on every case read.
--
-- Every one of these holds a closed vocabulary validated in TypeScript before
-- it arrives (question ids resolved against the reference store, assertion
-- kinds and stances from fixed enums), so what lands here is structured data,
-- never free text a model or a user wrote.
alter table pcn_cases
  add column if not exists context_answers      jsonb not null default '[]'::jsonb,
  add column if not exists confirmed_assertions jsonb not null default '[]'::jsonb,
  add column if not exists declared_evidence    jsonb not null default '[]'::jsonb,
  add column if not exists resolved_facts       jsonb not null default '[]'::jsonb;

comment on column pcn_cases.confirmed_assertions is
  'Facts read from the account that the user then confirmed. Kind and stance only — never the model summary, which is drawn from the account and would restate it.';

-- Shape guards. A malformed write is a bug, and a bug that stores an object
-- where the reader expects an array turns into a crash on resume rather than a
-- rejected write.
alter table pcn_cases
  drop constraint if exists pcn_cases_context_shapes,
  add constraint pcn_cases_context_shapes check (
    jsonb_typeof(context_answers) = 'array'
    and jsonb_typeof(confirmed_assertions) = 'array'
    and jsonb_typeof(declared_evidence) = 'array'
    and jsonb_typeof(resolved_facts) = 'array'
  );

-- ---------------------------------------------------------------------------
-- 2b. Notice facts the verification step establishes but 0004 had nowhere to put
-- ---------------------------------------------------------------------------

-- The printed deadlines matter most of these. Every calculated date is withheld
-- while its timing rule is awaiting legal review, so the date printed on the
-- notice is frequently the only one a user is shown — a resumed case without it
-- would lose the single actionable thing on the page.
--
-- The registration is kept as the text confirmed off the notice rather than
-- linked to `vehicles`. What the user verified is what the notice says, which is
-- not the same claim as "this person owns this vehicle", and inventing the
-- second from the first is exactly the kind of inference this product keeps
-- refusing to make. Linking a case to a vehicle a user has actually told us
-- about is a later, separate step.
alter table pcn_cases
  add column if not exists vehicle_registration_text      text,
  add column if not exists contravention_description      text,
  add column if not exists discount_deadline_printed      date,
  add column if not exists representation_deadline_printed date;

comment on column pcn_cases.discount_deadline_printed is
  'As printed on the notice. Never a date PCNWatch calculated — calculated dates are recomputed on read and withheld while their rule is unreviewed.';

-- ---------------------------------------------------------------------------
-- 3. Enough state to resume safely
-- ---------------------------------------------------------------------------

-- A case is saved before its assessment is produced, so that an assessment that
-- fails cannot cost the user the details they just confirmed. `case_status`
-- records which of those two things has happened.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'case_status') then
    create type case_status as enum ('DRAFT', 'VERIFIED', 'ASSESSED', 'ARCHIVED');
  end if;
end;
$$;

alter table pcn_cases
  add column if not exists status case_status not null default 'DRAFT',
  -- Bumped whenever the stored context changes, so a future resume can tell
  -- whether it is looking at what it last wrote.
  add column if not exists context_revision integer not null default 0,
  add column if not exists last_assessed_at timestamptz;

comment on column pcn_cases.status is
  'DRAFT until the notice is verified, VERIFIED once saved, ASSESSED once an assessment has been produced from it. A case is never left unsaved because an assessment failed.';

-- ---------------------------------------------------------------------------
-- 4. The owner cannot be got wrong
-- ---------------------------------------------------------------------------

-- With this default an insert from a user-scoped client omits `user_id`
-- entirely and the database fills in the caller's own identity. RLS already
-- rejected a mismatched owner; this removes the opportunity to supply one.
--
-- The service role is unaffected in the way that matters: `auth.uid()` is null
-- there, and the column is `not null`, so a service-role insert must still name
-- its owner explicitly rather than silently creating an ownerless row.
alter table pcn_cases alter column user_id set default auth.uid();

-- Listing a user's own cases, newest first, is the only cross-case query the
-- product makes. The index from 0004 already covers it (user_id, created_at
-- desc); this one covers the resume list ordered by recency of change.
create index if not exists pcn_cases_user_updated_idx
  on pcn_cases (user_id, updated_at desc);
