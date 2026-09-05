-- ---------------------------------------------------------------------------
-- What the authority itself calls each contravention code.
--
-- Deliberately NOT `contravention_codes`. That table is the approved legal
-- reference: every row carries a review status, a named source and a
-- jurisdiction, and it is the only thing the assessment engine, the evidence
-- checklist and the AI citation allow-list are permitted to read. Writing
-- publisher text into it would put unreviewed content behind a legal answer.
--
-- This table is descriptive labelling of enforcement data, nothing more. Camden
-- publishes `contravention_code_description` on every notice; 30 of the 40 codes
-- in its data have no reviewed reference record, covering more than half of all
-- events, so without this a location page shows "Code 33" and nothing else.
--
-- Rendered with attribution to the authority, and never as an explanation of
-- what the law requires.
-- ---------------------------------------------------------------------------

create table authority_contravention_labels (
  id            uuid primary key default gen_random_uuid(),
  authority_id  uuid not null references authorities (id) on delete cascade,
  code          text not null,
  -- Verbatim from the source. Never edited, never paraphrased.
  description   text not null,
  -- How many notices carried this exact wording, so a rare variant is visible
  -- rather than silently winning.
  event_count   integer not null default 0,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  unique (authority_id, code, description)
);

create index authority_contravention_labels_lookup_idx
  on authority_contravention_labels (authority_id, code, event_count desc);

alter table authority_contravention_labels enable row level security;

-- Public, like the enforcement data it describes. It contains no personal data:
-- a contravention code and the authority's own words for it.
create policy "public read authority_contravention_labels"
  on authority_contravention_labels for select using (true);

grant select on authority_contravention_labels to anon, authenticated;
