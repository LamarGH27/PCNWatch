# Real Camden ingestion — runbook

Everything needed to get real Camden PCN data into PCNWatch.

The first two steps need no configuration at all. A database is only needed once
you want to keep the data.

**The map will be empty, and that is the source's doing, not a fault.** Camden
publishes no coordinates. Street rankings, contravention breakdowns and time
profiles all work; nothing can be drawn until a street-reference dataset is
loaded. See [docs/geography.md](./geography.md).

> **Status.** The adapter has been confirmed against Camden's live dataset:
> 50/50 rows accepted, every enforcement class resolved, no coordinates
> published. The full pipeline — fetch, validate, normalise, write, aggregate,
> score, trace — has been proven end to end at 6,000 rows against a real
> PostgreSQL + PostGIS database, with the live schema. What has not been run is a
> full ingestion of the real dataset, because the environment it was built in
> blocks egress to `opendata.camden.gov.uk` at an organisation policy gateway.

---

## Prerequisites

- **Node 20.11+**
- For writing: **PostgreSQL 15+ with PostGIS.** Postgres 15 is the minimum
  because the unique indexes use `NULLS NOT DISTINCT`. A dry run needs no
  database at all. `psql` is **not** required — `db:setup` runs the migrations
  through the same `pg` client the pipeline uses. (Only `npm run db:test`, the
  SQL suites, needs `psql`, because those files use its meta-commands.)
- Network access to `opendata.camden.gov.uk`.

```bash
npm install
```

---

## 1. Look at the source — no setup needed

```bash
npm run camden:probe
```

The dataset endpoint defaults to Camden's published PCN dataset
(`4k7m-4gkk`), which has been probed live and is what the adapter is written
against. `--url` or `CAMDEN_PCN_DATASET_URL` points it somewhere else.

The probe prints every column with its type, fill rate and a scrubbed sample;
how the adapter's aliases map onto them; the enforcement classes present and the
contravention descriptions behind each; the precision the publisher claims; and
what happens when 50 rows are normalised. Its output is safe to paste into an
issue — values are truncated and registration-shaped text is redacted, except in
location columns, where postcode districts and road numbers are kept because
they are the evidence the probe exists to gather.

It exits non-zero if the adapter cannot read the dataset, and prints the alias
list the running build actually compiled in so a stale checkout is visible
rather than mistaken for a wrong alias.

---

## 2. Dry run — still no setup needed

```bash
npm run ingest:camden -- --dry-run --limit 5000
```

Fetches, validates, normalises and measures quality, and writes nothing.

---

## 3. A database, if you want to keep the data

```bash
docker run -d --name pcnwatch-db -p 5432:5432 \
  -e POSTGRES_PASSWORD=postgres postgis/postgis:16-3.4
export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres
npm run db:setup
cp .env.example .env.local     # then check DATABASE_URL in it
```

`db:setup` waits for the container to start accepting connections, so running it
straight after `docker run` is fine. It verifies PostGIS is actually present
rather than letting that surface halfway through an ingestion.

`db:setup` drops and recreates a `pcnwatch` database, applies every migration in
order, and seeds the authority directory, products and the Camden source record.
Anything in `.env.local` is picked up automatically by these scripts; real
environment variables always win over it.

Against a hosted Supabase project, skip `db:setup` and instead apply
`supabase/migrations/*.sql` then `supabase/seed/001_reference.sql` through the
Supabase SQL editor. Do **not** apply `supabase/test/00_supabase_shim.sql` there —
the platform supplies what it stands in for.

---

## 4. Ingest

**Camden's dataset is over a million rows.** The pipeline builds the whole set in
memory before writing, so there is a deliberate ceiling — 40 pages of 50,000 —
and a fetch that reaches it **refuses** rather than storing a truncated copy. If
you hit `PAGE_BUDGET_EXHAUSTED`, bound the run by date rather than raising the
ceiling on a small machine:

```bash
npm run ingest:camden -- --since 2024-01-01
```

Re-running with an earlier `--since` later is safe: records are matched on
`(source_id, source_record_id)`, so a wider run fills in what a narrower one
missed rather than duplicating it.

When the dry-run report looks right:

```bash
npm run ingest:camden
```

This fetches the dataset, records source provenance and a content hash, validates
and normalises every row, rejects bad rows with a reason, deduplicates, writes
events and locations inside a single transaction, rebuilds aggregates, recomputes
Ticket Activity Scores for all three periods, and prints a full report.

**Exit codes**

| Code | Meaning |
| --- | --- |
| `0` | Ingested. Rejected rows, if any, are itemised in the report. |
| `1` | Ingestion failed, **or** it succeeded but the data-quality gate did not pass. |
| `2` | Not configured. Nothing was attempted. |

The quality gate failing with exit 1 is not a bug: the data is real and stored,
and it is not good enough to present as enforcement intelligence. The report says
which threshold failed.

The report also prints a **map readiness** line, which is not the same question as
the gate. `NO_SOURCE_GEOGRAPHY` means the dataset publishes no coordinates at
all — the records are intact and worth storing, and positions would have to come
from a separate street-reference dataset ([docs/geography.md](./geography.md)).
`GEOGRAPHY_UNREADABLE` means coordinates are published and we could not read
them, which *is* an adapter fix. No position is ever invented to fill the gap.

### Useful flags

```bash
npm run ingest:camden -- --limit 20000        # bound the first run
npm run ingest:camden -- --since 2025-01-01   # incremental refresh
```

---

## 5. Prove the numbers trace to source

```bash
npm run camden:trace              # top 5 locations by activity
npm run camden:trace -- --slug eversholt-street
```

For each location this prints the whole chain — the stored source rows and which
columns they came from, the normalised counts, the aggregate buckets, the score
with its components, and exactly what the hotspot page renders — with
reconciliation checks at each join. If a displayed total does not equal the
source-derived total, it prints `✗ DOES NOT RECONCILE` rather than the number.

It also recomputes each score live and compares it with the stored one, so a
stale score is visible rather than trusted.

---

## 6. See it

```bash
npm run build && npm start
```

`/map` and `/hotspots` read through the same database functions the trace tool
uses. With `DATABASE_URL` set and no Supabase configured, the app reads Postgres
directly.

**The map needs a basemap.** Without `NEXT_PUBLIC_MAP_STYLE_URL` it falls back to
MapLibre's demo style, which has country outlines only and stops at about zoom 5
— so the enforcement data draws correctly onto a flat colour with no streets
beneath it. The map states this when it happens rather than leaving it looking
broken. `.env.example` lists the options and the licensing question behind
choosing one.

---

## Refresh cadence and failure behaviour

Re-running ingestion is safe and idempotent: records are matched on
`(source_id, source_record_id)` and classified as inserted, updated or unchanged
by comparing a hash of the normalised row. Re-ingesting an unchanged dataset
reports every row as `unchanged` and writes nothing new.

**A failed refresh never destroys good data.** Writes happen inside one
transaction; if the pipeline judges the payload unusable it rolls back and the
previous data stays exactly as it was. The failure is recorded as a `FAILED`
ingestion run, and the freshness timestamp the UI shows continues to be that of
the last *successful* run — so the site reports stale data as stale rather than
pretending the refresh worked. This is covered by
`supabase/test/03_ingestion_safety.test.sql`.

## Demo data cannot masquerade as real

Any ingestion whose URL is not on `opendata.camden.gov.uk` is recorded with
`demo: true` on the run. The coverage layer reads that flag and forces a
"Demonstration data" banner stating the figures are fabricated. The CLI also
prints a warning before starting such a run.

There is no code path that silently substitutes fixture data for the real source.
If the source is unreachable the adapter throws; it never returns an empty array,
which downstream would read as "Camden issued no PCNs".

---

## What to send back for verification

After a real run, the following is enough to confirm the gate is closed:

1. The full output of `npm run camden:probe`.
2. The full output of `npm run ingest:camden`.
3. The output of `npm run camden:trace`.

Those three cover source shape, ingestion counts, data quality, score
distribution, and source-to-UI traceability.
