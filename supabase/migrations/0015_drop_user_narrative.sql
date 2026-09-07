-- Contract step: remove the column the user's account could have been kept in.
--
-- ===========================================================================
-- DO NOT APPLY THIS UNTIL PRODUCTION IS RUNNING CODE THAT DOES NOT NAME IT.
-- ===========================================================================
--
-- This is the second half of an expand → deploy → contract change. 0014 added
-- everything the new persistence needs without touching anything the old code
-- reads; this removes what the old code read, and is therefore only safe once
-- nothing is reading it.
--
-- The order, and why each step is where it is:
--
--   1. Apply 0014. Purely additive, so the running Production build — which
--      still selects `user_narrative` in `getCase` — carries on unaffected.
--   2. Deploy the application. From this point `user_narrative` appears in no
--      query: the reader selects `narrative_provided` instead, and the writer
--      has never had a column for the account at all.
--   3. Verify the deploy is actually live and serving — not merely built. A
--      rollback to the previous build after this migration would reintroduce
--      the old query against a column that no longer exists.
--   4. Apply this migration.
--
-- Running this at step 1 instead would break every case page the instant it
-- ran, for as long as it took a deploy to catch up: Postgres rejects a select
-- naming a column that does not exist, so `getCase` would fail outright rather
-- than degrade. That is an outage manufactured by doing two separable things at
-- once, and the cost of separating them is one extra migration.
--
-- Why remove it at all, rather than leave an unused column alone:
--
-- The account someone writes about their own case may name a hospital, a child,
-- an employer or an illness. The product keeps it in the browser and sends only
-- the fact that it exists. A column that must never be written is one `insert`
-- away from being written, and a rule that lives in a comment is one that a
-- future code path can be unaware of. Removing it makes the privacy boundary
-- structural: there is no longer anywhere for the text to go.
--
-- There is no data to lose. The column was defined in 0004 and no code path has
-- ever written to it, so this drops nulls. The guard below refuses to run if
-- that ever stopped being true, because silently deleting people's words would
-- be a far worse outcome than a failed migration.

do $$
declare
  populated bigint;
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'pcn_cases' and column_name = 'user_narrative'
  ) then
    raise notice 'user_narrative is already gone; nothing to do.';
    return;
  end if;

  execute 'select count(*) from pcn_cases where user_narrative is not null' into populated;

  if populated > 0 then
    raise exception
      'Refusing to drop pcn_cases.user_narrative: % rows hold a value. This column was never meant to be written; find out what wrote it before deleting what people said.',
      populated
      using errcode = 'raise_exception';
  end if;

  alter table pcn_cases drop column user_narrative;
  raise notice 'Dropped pcn_cases.user_narrative (0 rows held a value).';
end;
$$;
