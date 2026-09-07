-- ---------------------------------------------------------------------------
-- The database decides who owns an evidence row
-- ---------------------------------------------------------------------------
--
-- `pcn_cases.user_id` has defaulted to `auth.uid()` since 0014, so the save
-- endpoint sends no owner and cannot attribute a case to anybody but its
-- caller. `pcn_evidence.user_id` never got the same default, and the evidence
-- upload was written in the shape of the case save — no user_id in the insert.
--
-- RLS then evaluated `with check (user_id = (select auth.uid()))` as
-- `NULL = uuid`, which is NULL rather than true, so every upload was refused
-- with 42501 before the NOT NULL constraint was ever reached. The first real
-- upload in Preview failed on exactly this.
--
-- The application now sends the owner from the session it has already verified,
-- so this migration is not what unblocks the upload — it is what stops the next
-- insert that forgets the column from failing the same way. Where the value can
-- come from the database, it should: an insert with no owner gets the right one
-- instead of a policy violation, and there is one less parameter for a future
-- code path to get wrong.
--
-- This does not widen anything. The default only supplies a value where none
-- was given; the `with check` still rejects any other user, and
-- `assert_case_belongs_to_user` still rejects a case belonging to somebody
-- else. Both are asserted in 07_evidence_lifecycle.test.sql.
--
-- Expand-only and idempotent. Safe to apply to a Production database running
-- the current code: nothing reads the default, and code that sends its own
-- user_id is unaffected by it.

alter table pcn_evidence alter column user_id set default auth.uid();

comment on column pcn_evidence.user_id is
  'Owner. Defaults to auth.uid() so an insert that omits it is attributed to the caller rather than refused by RLS. A value other than the caller is still rejected by the row policy and by assert_case_belongs_to_user().';
