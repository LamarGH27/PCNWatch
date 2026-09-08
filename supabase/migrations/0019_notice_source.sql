-- ---------------------------------------------------------------------------
-- Where the notice details came from
-- ---------------------------------------------------------------------------
--
-- A case built by photographing a PCN and a case typed in by hand are
-- indistinguishable once saved. Both end up as verified fields on `pcn_cases`
-- and nothing records which happened.
--
-- That gap reached the paid product. A Defence Pack generated from a scanned
-- Westminster notice listed "The penalty charge notice has not been provided"
-- among its weaknesses — to somebody who had photographed that exact notice
-- ninety seconds earlier. The Pack was not wrong about `pcn_evidence`, which
-- was genuinely empty; it was wrong about what the case knew, because the one
-- fact that would have told it was never written down.
--
-- So the source is recorded. It stays distinct from `pcn_evidence` on purpose:
-- a scanned notice is the document the case was *derived from*, read by the
-- extraction pipeline and confirmed field by field, while an evidence upload is
-- a document the user later chose to attach and have read. Collapsing them
-- would lose the difference between "we built this case from that document" and
-- "the user gave us that document as support".
--
-- Expand-only and idempotent, in the same style as 0014, 0016 and 0018. The
-- default is MANUAL, so every existing row keeps exactly the meaning it has
-- today and no currently deployed code path changes behaviour.

alter table pcn_cases
  add column if not exists notice_source text not null default 'MANUAL';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pcn_cases_notice_source_known'
  ) then
    alter table pcn_cases
      add constraint pcn_cases_notice_source_known
      check (notice_source in ('MANUAL', 'SCANNED'));
  end if;
end;
$$;

comment on column pcn_cases.notice_source is
  'SCANNED when the case was built from an uploaded notice the extraction pipeline read and the user confirmed; MANUAL when the details were typed in. Distinct from pcn_evidence, which holds documents the user attached as support.';
