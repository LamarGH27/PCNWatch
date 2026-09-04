# FineRadar

**See where tickets happen. Understand why. Fight yours.**

A UK driver tool combining historical PCN enforcement intelligence with PCN
document analysis, deadline tracking, evidence management and evidence-based
challenge drafting.

FineRadar provides information and document-preparation tools. It does not
provide legal advice and does not guarantee that a challenge will succeed.

---

## Current status

| | |
| --- | --- |
| Build | Passing |
| Lint | Clean |
| Unit tests | 199 passing |
| Database tests | 22 assertions against real PostgreSQL 16 + PostGIS 3.4 |
| Enforcement map coverage | **Camden only** — and only once data has been ingested |
| Live Camden ingestion | **Not yet run.** Pipeline verified against fixtures and a local HTTP server |
| Legal review of encoded rules | **Outstanding.** All rules marked `PENDING_LEGAL_REVIEW` |

Read [`docs/architecture.md`](docs/architecture.md) for the full assessment,
including what is verified, what is built but unexercised, and what needs a human
before launch.

## Quick start

```bash
npm install
cp .env.example .env.local     # optional — the app builds without credentials
npm run dev
```

Everything public works without credentials, stating explicitly where data is
unavailable rather than showing placeholders.

## Commands

| Command | Does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest |
| `npm run db:test` | Rebuild the database from migrations and run the SQL suites |
| `npm run verify` | typecheck + lint + test + build |
| `npm run ingest:camden -- --dry-run` | Validate the Camden source without writing |
| `npm run ingest:camden` | Ingest, rebuild aggregates, recompute scores |

## Database

```bash
# Requires PostgreSQL with PostGIS.
PGHOST=/tmp PGPORT=5433 npm run db:test
```

`scripts/db-test.sh` drops and recreates a scratch database, applies the local
Supabase shim (`supabase/test/00_supabase_shim.sql` — never applied to a real
Supabase project), applies every migration in order, and runs the SQL test suites.

Against a real Supabase project, apply `supabase/migrations/*.sql` in order and
skip the shim.

## Principles this codebase enforces in code, not documentation

- **Never fabricate.** No invented statistics, legislation, cases, exemptions or
  coverage. Model output citing anything outside the approved reference store is
  rejected before it reaches a user.
- **Activity is not permission.** Enforcement history and parking legality are
  different questions and the UI keeps them apart.
- **No win probabilities.** Evidence basis, never a percentage.
- **Absence is stated, not filled.** A missing figure says why it is missing. A
  datastore failure says it is our problem, never "no tickets here".
- **Deadlines are computed, not guessed.** Deterministic rules with citations; a
  model is never asked to calculate a legal date.
- **Payment comes from the webhook.** A success redirect grants nothing, enforced
  by a database constraint as well as by application code.
- **Demo data is unmistakable.** Production never silently falls back to it.

## Repository layout

See [`docs/architecture.md`](docs/architecture.md#3-shape-of-the-codebase).

## Further reading

- [`docs/architecture.md`](docs/architecture.md) — assessment, schema, credentials, assumptions, honest status
- [`docs/ticket-activity-score.md`](docs/ticket-activity-score.md) — the scoring model, why the proposed weighting was changed
