# FineRadar — architecture assessment

## 1. Starting point

The repository was **empty**: no framework, no dependencies, no history, no
database. This is a from-scratch build, so there was no working infrastructure to
preserve and no legacy to audit around.

Two constraints were established before any code was written, because they shape
what "done" can mean:

| Constraint | Consequence |
| --- | --- |
| Camden's open-data host is blocked by this environment's egress policy | The Camden adapter and pipeline are complete and tested against fixtures and a local HTTP server, but **no live Camden ingestion has been run**. |
| No Supabase, Anthropic, Stripe or D-TRO credentials exist | Every integration is built to its boundary and refuses when unconfigured. Nothing fakes a successful response. |

The database schema, RLS policies and aggregation functions were **not** merely
written — they were applied and exercised against a real PostgreSQL 16 + PostGIS
3.4 cluster, and `scripts/db-test.sh` reproduces that from scratch.

## 2. Stack

| Layer | Choice | Why |
| --- | --- | --- |
| Framework | Next.js 15 (App Router), React 19 | Server components keep aggregation on the server; one deployment artefact. |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | Index access returning `T \| undefined` catches a whole class of aggregate-parsing bugs. |
| Database | PostgreSQL + PostGIS (Supabase) | Spatial queries and RLS in one place. RLS is the reason this is not "any database". |
| Auth | Supabase Auth | Same identity the RLS policies key on. |
| Map | MapLibre GL JS | No per-view licensing; tile provider is a config value, not a dependency. |
| Validation | Zod | Same library validates env, model output and API input. |
| Tests | Vitest + SQL suites | Domain logic in Vitest; anything policy-shaped in SQL, against a real database. |
| Payments | Stripe Checkout | Hosted; we never touch card data. |

Deliberately **not** used: an ORM (the schema is the interesting part and SQL
expresses it better), a state-management library (server components carry the
state), a component library (the design brief is specific enough that a generic
kit would fight it).

## 3. Shape of the codebase

```
src/
  core/            Pure domain logic. No I/O, no framework, exhaustively tested.
    scoring/         Ticket Activity Score
    deadlines/       Deterministic deadline rules + calendar arithmetic
    reference/       Versioned approved-reference store (the citation allow-list)
    evidence/        Evidence types, capture guidance, requirement matrix
    assessment/      Rules-driven case assessment
    notices/         Deterministic notice classification (scope gate)
    case/            Procedural state machine
    coverage/        What we are allowed to claim about a place
  data-sources/    Ingestion adapters
    shared/          Adapter contract, normalisation, PII guard, pipeline
    camden/          Camden schema + adapter
    dtro/            D-TRO client (stops at the credential boundary)
  server/          Server-only. Never imported by client code.
    ai/              Anthropic abstraction, schemas, validation gate, prompts
    payments/        Catalogue, Stripe, entitlements
    ingestion/       Supabase sink, scoring job
    repositories/    Read models for public data
    admin/           Access control + data health
  lib/             Env contract, Supabase clients, error contract
  app/             Routes and UI
  components/      Shared presentational primitives
supabase/
  migrations/      0001–0008, applied in order
  test/            Supabase shim (local only) + SQL test suites
```

The rule that keeps this honest: **`src/core` may not import from `src/server`,
`src/app` or `src/data-sources`.** Everything in `core` is a pure function of its
inputs, which is why the scoring and deadline behaviour can be tested to the
degree it is.

## 4. Data model

Twenty-eight tables across five migrations. The parts worth explaining:

**Provenance is structural, not documentation.** `data_sources` →
`source_versions` → `ingestion_runs` → `ingestion_errors` means any displayed
figure can answer "where did this come from, which version, retrieved when, and
what was rejected from that run".

**Public and private data are separated at the table level, not by a flag.**
`pcn_events` and its aggregates contain no personal data and have no column that
could. User data lives in `pcn_cases` and its children, each carrying its own
`user_id` so every RLS policy is a single index-backed predicate.

**Scores record their own refusals.** `pcn_activity_scores` has a CHECK
constraint requiring either a score *or* a refusal reason. A location we will not
score gets a row saying why, because no row is indistinguishable from "not
computed yet".

**Payments cannot lie.** `payments` has a CHECK that a row cannot be `PAID`
without `confirmed_by_webhook_at`. Only the webhook handler sets that column.

## 5. Security model

Four layers, each independently sufficient to stop the obvious attack:

1. **Table privileges (0007).** Supabase's defaults grant ALL on public tables to
   `anon` and `authenticated`, leaving RLS as the only barrier. Those defaults are
   revoked; each role is granted exactly what it needs. An anonymous request for a
   case is refused before RLS is consulted.
2. **RLS (0006).** Owner-only policies on every user table. `pcn_events`,
   `ai_logs`, `audit_events` and ingestion internals have no client policy at all.
3. **Ownership triggers.** RLS alone would let a user attach a row to their own
   `user_id` but another user's `case_id`. Triggers assert the two agree.
4. **Storage.** Private buckets, paths prefixed with the owner's user id, and RLS
   explicitly enabled on `storage.objects` — the policy tests initially caught
   User B reading User A's document because the policies existed but RLS was left
   to a platform default.

## 6. AI architecture

A model is reached from exactly one server-only module. Every response passes
three gates before it can be used or stored:

1. **Schema.** Zod. No partial acceptance.
2. **Citations.** Every reference key must exist in the approved store *and* have
   been supplied as context for that call. Citing a real reference that was not
   offered is still a fabricated connection.
3. **Groundedness.** Explanation jobs must return exactly the findings the rules
   engine produced. Drafting jobs must map every factual assertion to a verified
   case field, the user's own narrative, or an attached evidence item, and the
   body is checked for fabricated case citations, invented statutory sections,
   guarantees and numeric win probabilities.

Rejected output is logged as rejected and never retried into acceptance. Logs
store a fingerprint of the input rather than the input.

**Rules are never in prompts.** A rule stated in a prompt cannot be versioned,
cited or reviewed. Prompts say what shape of output is expected and what the model
must not do; the rules live in `src/core/reference` with citations.

## 7. Required credentials

| Variable | For | Without it |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Client auth + reads | Auth and case storage unavailable; public pages render an explicit "unavailable" state |
| `SUPABASE_SERVICE_ROLE_KEY` | Ingestion, webhook, admin | Ingestion refuses to run |
| `ANTHROPIC_API_KEY` | Document reading | Manual entry path only, stated in the UI |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Payments | Checkout refuses; nothing is ever marked paid |
| `CAMDEN_PCN_DATASET_URL` | Camden ingestion | Adapter throws `NOT_CONFIGURED` rather than returning an empty result |
| `DTRO_CLIENT_ID`, `DTRO_CLIENT_SECRET`, `DTRO_BASE_URL` | D-TRO | Client refuses every call; UI stays behind its flag |
| `ADMIN_EMAIL_ALLOWLIST` | Data-health page | Empty means deny everyone |
| `NEXT_PUBLIC_POSTHOG_KEY` | Analytics | No events sent |

`NEXT_PUBLIC_MAP_STYLE_URL` defaults to MapLibre's demo tiles, which are fine for
development and **must** be replaced before launch.

## 8. Critical assumptions

1. **Camden publishes PCN data with a per-record identifier, a date, a street and
   ideally coordinates.** The adapter resolves each logical field through an alias
   list and fails loudly if none match, so a wrong guess surfaces as a rejected
   run rather than a column of nulls — but the alias lists are the biggest thing
   to verify against the live dataset.
2. **The dataset does not contain personal data.** We assume it might anyway. The
   PII guard is allow-list based for exactly this reason.
3. **The encoded deadline rules are correct.** They carry citations but are all
   marked `PENDING_LEGAL_REVIEW`, and the calculator will not report HIGH
   confidence for an unreviewed rule. **This must be signed off by a qualified
   person before launch.**
4. **Contravention descriptions are accurate.** Twelve codes are encoded from the
   published national list. All are unreviewed and therefore `noindex` and absent
   from the sitemap. Publishing them for search traffic requires review first.
5. **Camden has enough distinct locations for percentile ranking to be
   meaningful.** The scorer refuses below five comparable locations.

## 9. Where the specification adds cost without MVP value

Stated plainly, with what was done about each:

| Item | Assessment | Action taken |
| --- | --- | --- |
| `road_segments` alongside `parking_locations` | Two spatial hierarchies before we know the street-name data quality. | Table exists for later; only `parking_locations` is populated and queried. |
| `subscriptions` table | Explicitly out of scope for V1. | Created so adding it later is not a redesign; intentionally unused. |
| D-TRO | Needs credentials that do not exist, and coverage that has not been measured. | Client built and tested; flagged off; coverage reports UNAVAILABLE until measured. |
| Three paid products at launch | Two of them serve stages most users will not reach in month one. | All three in the catalogue; only the Defence Pack is on the critical path to first revenue. |
| Day-of-week filtering on the map | Depends on the source recording times, which is unverified. | Score supports it; UI exposes hour filtering, and profiles render only where times exist. |
| Separate case-summarisation AI job | Duplicates what the dashboard already renders deterministically. | Schema defined; not wired to a surface. |

**The one simplification I would push hardest for:** ship with the Defence Pack
alone. The Rejection Review and Appeal Pack serve users at stages most people
will not reach within the first month, and every extra product is another
purchase path to test. The catalogue is a data table, so adding them later is a
few lines.

## 10. Honest status

**Verified working:** build, lint, 199 unit tests, 22 SQL assertions against real
PostgreSQL + PostGIS, ingestion pipeline end to end over HTTP against a fixture
server (12 fetched, 4 rejected with distinct reasons, 7 accepted after
deduplication, 5 geolocated).

**Built but not run against the real thing:** Camden ingestion against Camden
(host blocked), anything requiring Supabase, Anthropic or Stripe credentials.

**Requires a human before launch:** legal review of the deadline rules and the
contravention descriptions; a production tile provider; measuring D-TRO coverage
before enabling that flag.
