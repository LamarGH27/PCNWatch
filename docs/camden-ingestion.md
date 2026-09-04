# Real Camden ingestion — runbook

Everything needed to get real Camden PCN data into PCNWatch and prove the map
works against it. Three commands, in order.

> **Status.** The pipeline is complete and has been proven end to end against a
> real PostgreSQL + PostGIS database. It has **not** been run against Camden's
> live dataset, because the environment it was built in blocks egress to
> `opendata.camden.gov.uk` at an organisation policy gateway. Steps 1–3 below are
> the boundary: run them and the gate closes.

---

## Prerequisites

- **Node 20.11+**
- **PostgreSQL 15+ with PostGIS.** Postgres 15 is the minimum because the unique
  indexes use `NULLS NOT DISTINCT`.
- Network access to `opendata.camden.gov.uk`.

A hosted Supabase project works too — use the connection string it gives you as
`DATABASE_URL`. Supabase is not required: ingestion and the map both run against
plain Postgres.

```bash
npm install
```

---

## 1. Create the database

```bash
export PGHOST=localhost PGPORT=5432 PGUSER=postgres
npm run db:setup
export DATABASE_URL="postgres://postgres@localhost:5432/pcnwatch"
```

This drops and recreates a `pcnwatch` database, applies every migration in order,
and seeds the authority directory, products and the Camden source record.

Against a hosted Supabase project, skip `db:setup` and instead apply
`supabase/migrations/*.sql` then `supabase/seed/001_reference.sql` through the
Supabase SQL editor. Do **not** apply `supabase/test/00_supabase_shim.sql` there —
the platform supplies what it stands in for.

---

## 2. Find the dataset and confirm its schema

Open <https://opendata.camden.gov.uk> and find the penalty charge notice dataset.
Its API endpoint contains a four-by-four id, e.g. `abcd-1234`. Then:

```bash
npm run camden:probe -- --url "https://opendata.camden.gov.uk/resource/<id>.json"
```

This fetches 50 rows and prints every column with its type, fill rate and a
scrubbed sample; how the adapter's alias lists map onto those columns; and what
happens when the sample is normalised.

**Run this before a full ingestion.** A fixture is a guess about production, and
the probe is what turns the guess into evidence. Its output is safe to paste into
an issue — values are truncated and registration-shaped text is redacted.

It exits non-zero if the adapter cannot read the dataset. The two likely causes:

| Probe says | Fix |
| --- | --- |
| `✗ REQUIRED` next to `recordId` or `street` | Add the real column name to `FIELD_ALIASES` in `src/data-sources/camden/schema.ts`, then re-probe. |
| Rows normalise but none are geolocated | Read the probe's verdict. It distinguishes a dataset that publishes **no** coordinates (dataset `4k7m-4gkk` is one — see [docs/geography.md](./geography.md)) from one whose coordinates we failed to read. Only the second is an adapter fix: add the point column to `POINT_FIELD_CANDIDATES`. |

Once it reports `✓`:

```bash
export CAMDEN_PCN_DATASET_URL="https://opendata.camden.gov.uk/resource/<id>.json"
```

---

## 3. Ingest

Start bounded, to see the shape of the data before committing to a full run:

```bash
npm run ingest:camden -- --dry-run --limit 5000
```

A dry run fetches, validates, normalises and measures quality, and writes
nothing. When the report looks right:

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

## 4. Prove the numbers trace to source

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

## 5. See it

```bash
npm run build && npm start
```

`/map` and `/hotspots` read through the same database functions the trace tool
uses. With `DATABASE_URL` set and no Supabase configured, the app reads Postgres
directly.

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
