/**
 * Source traceability.
 *
 *   npm run camden:trace                 # top 5 locations by activity
 *   npm run camden:trace -- --limit 10
 *   npm run camden:trace -- --slug eversholt-street
 *
 * For each location, walks the whole chain and prints it:
 *
 *   SOURCE PROVENANCE → AGGREGATE ROWS → SCORE → WHAT THE UI SHOWS
 *
 * The point is to make a displayed number falsifiable. Every figure on a hotspot
 * page should be reconstructible from the rows printed here; if a count does not
 * reconcile, this prints the discrepancy rather than the pretty number.
 *
 * The first link in that chain used to be the notices themselves. They are no
 * longer stored — the pipeline aggregates in flight and discards them — so what
 * stands in their place is the dataset version's provenance: where the rows came
 * from, when, how many arrived, and how many are accounted for by what was
 * stored. A dataset whose stored counts do not equal its accepted count is never
 * published, so that equality is the guarantee this replaces the raw rows with.
 *
 * Requires DATABASE_URL.
 */

import './load-env';
import { Pool } from 'pg';
import { computeTicketActivityScores } from '../src/core/scoring/ticket-activity-score';
import { classificationLabel } from '../src/core/scoring/ticket-activity-score';
import type { LocationActivityInput } from '../src/core/scoring/types';

interface Args {
  limit: number;
  slug?: string;
  period: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 5, period: '12M' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--slug') args.slug = argv[++i];
    else if (argv[i] === '--period') args.period = argv[++i] as string;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error('\n✗ DATABASE_URL is not set.\n');
    process.exit(2);
  }

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? undefined : { rejectUnauthorized: false },
  });

  try {
    const { rows: runs } = await pool.query<{
      finished_at: string | null;
      status: string;
      report: { demo?: boolean };
      version_label: string | null;
      source_url: string | null;
      name: string;
    }>(
      `select r.finished_at, r.status, r.report, v.version_label, s.source_url, s.name
       from ingestion_runs r
       join data_sources s on s.id = r.source_id
       left join source_versions v on v.id = r.source_version_id
       where r.status in ('SUCCEEDED', 'PARTIAL')
       order by r.finished_at desc nulls last
       limit 1`,
    );
    const run = runs[0];

    console.log('\nPROVENANCE');
    console.log('─'.repeat(96));
    if (!run) {
      console.log('  No successful ingestion run found. Run `npm run ingest:camden` first.\n');
      process.exit(1);
    }
    console.log(`  source           ${run.name}`);
    console.log(`  source url       ${run.source_url ?? '(none)'}`);
    console.log(`  version          ${run.version_label ?? '(none)'}`);
    console.log(`  last ingested    ${run.finished_at ?? '(unfinished)'}  [${run.status}]`);
    console.log(`  demo data        ${run.report?.demo === true ? 'YES — not real enforcement data' : 'no'}`);

    const { rows: locations } = await pool.query<{
      id: string;
      slug: string;
      display_name: string;
      data_confidence: string;
      has_geom: boolean;
      geometry_source: string | null;
      geometry_method: string | null;
      geometry_reference_version: string | null;
      raw_count: string;
    }>(
      `select l.id, l.slug, l.display_name, l.data_confidence,
              l.geom is not null as has_geom,
              l.geometry_source, l.geometry_method, l.geometry_reference_version,
              coalesce(sum(d.pcn_count), 0)::text as raw_count
       from parking_locations l
       join authorities a on a.id = l.authority_id and a.slug = 'camden'
       left join pcn_activity_daily d
              on d.parking_location_id = l.id
             and d.dataset_version_id = pcnwatch_active_version('camden')
       ${args.slug ? 'where l.slug = $2' : ''}
       group by l.id
       order by coalesce(sum(d.pcn_count), 0) desc
       limit $1`,
      args.slug ? [args.limit, args.slug] : [args.limit],
    );

    if (locations.length === 0) {
      console.log('\n  No locations found. Has ingestion run?\n');
      process.exit(1);
    }

    // Scores are recomputed here from the stored aggregates, independently of
    // whatever is in pcn_activity_scores, so a stored score that does not match
    // is visible as a discrepancy rather than trusted.
    const { rows: scoringRows } = await pool.query(
      'select * from pcnwatch_scoring_inputs($1, null, null)',
      ['camden'],
    );
    const inputs: LocationActivityInput[] = scoringRows.map((row) => ({
      locationId: String(row.location_id),
      buckets: Array.isArray(row.monthly_counts)
        ? row.monthly_counts.map((b: { periodStart: string; count: number }) => ({
            periodStart: String(b.periodStart).slice(0, 10),
            count: Number(b.count),
          }))
        : [],
      temporal: {
        hourCounts: indexed(row.hour_counts, 24),
        dayOfWeekCounts: indexed(row.day_counts, 7),
      },
      dataConfidence: Number(row.data_confidence ?? 0),
      hasGeometry: Boolean(row.has_geometry),
    }));
    const asOf = new Date().toISOString().slice(0, 10);
    const recomputed = new Map(
      computeTicketActivityScores(inputs, { asOf }).map((r) => [r.locationId, r]),
    );

    for (const location of locations) {
      await traceLocation(pool, location, recomputed, args.period, asOf);
    }

    console.log('');
  } finally {
    await pool.end();
  }
}

async function traceLocation(
  pool: Pool,
  location: {
    id: string;
    slug: string;
    display_name: string;
    data_confidence: string;
    has_geom: boolean;
    geometry_source: string | null;
    geometry_method: string | null;
    geometry_reference_version: string | null;
    raw_count: string;
  },
  recomputed: Map<string, ReturnType<typeof computeTicketActivityScores>[number]>,
  period: string,
  asOf: string,
): Promise<void> {
  console.log(`\n\n${'='.repeat(96)}`);
  console.log(`LOCATION  ${location.display_name}   (/hotspots/camden/${location.slug})`);
  console.log(`period ${period}   ·   scores recomputed as of ${asOf}`);
  console.log('='.repeat(96));

  /* 1. Where the figures came from --------------------------------------- */

  const { rows: provenance } = await pool.query<{
    id: string;
    source_url: string | null;
    source_dataset_id: string | null;
    source_fetched_at: string | null;
    source_schema_fingerprint: string | null;
    rows_fetched: number | null;
    rows_accepted: number | null;
    rows_rejected: number | null;
    aggregate_total: number | null;
    is_demo: boolean;
    activated_at: string | null;
  }>(
    `select id, source_url, source_dataset_id, source_fetched_at::text,
            source_schema_fingerprint, rows_fetched, rows_accepted, rows_rejected,
            aggregate_total, is_demo, activated_at::text
       from enforcement_dataset_versions
      where id = pcnwatch_active_version('camden')`,
  );
  const v = provenance[0];

  console.log('\n1. SOURCE  (the notices themselves are not stored; this is what they came from)');
  if (!v) {
    console.log('   (no active dataset version — nothing is published for this authority)');
    return;
  }
  console.log(`   dataset url          ${v.source_url ?? '(none)'}`);
  console.log(`   dataset id           ${v.source_dataset_id ?? '(none)'}`);
  console.log(`   fetched at           ${v.source_fetched_at ?? '(none)'}`);
  console.log(`   schema fingerprint   ${v.source_schema_fingerprint ?? '(none)'}`);
  console.log(`   published at         ${v.activated_at ?? '(not published)'}`);
  console.log(`   demo data            ${v.is_demo ? 'YES — not real enforcement data' : 'no'}`);
  console.log(
    `   rows                 ${v.rows_fetched ?? '?'} fetched, ${v.rows_accepted ?? '?'} accepted, ` +
      `${v.rows_rejected ?? '?'} rejected`,
  );
  const versionReconciles = v.aggregate_total === v.rows_accepted;
  console.log(
    `   reconciliation       ${v.aggregate_total ?? '?'} stored vs ${v.rows_accepted ?? '?'} accepted → ` +
      `${versionReconciles ? 'MATCH' : '*** MISMATCH ***'}`,
  );

  /* 2. This street's aggregate rows --------------------------------------- */

  const { rows: sample } = await pool.query<{
    activity_date: string;
    contravention_code: string | null;
    enforcement_class: string;
    pcn_count: number;
    hour_histogram: number[];
    via_cctv: boolean | null;
  }>(
    `select activity_date::text, contravention_code, enforcement_class::text,
            pcn_count, hour_histogram, via_cctv
       from pcn_activity_daily
      where parking_location_id = $1 and dataset_version_id = pcnwatch_active_version('camden')
      order by activity_date desc, pcn_count desc
      limit 3`,
    [location.id],
  );

  console.log('\n2. STORED  (3 most recent aggregate rows — one row is many notices)');
  for (const r of sample) {
    const hours = r.hour_histogram
      .map((n, hour) => (n > 0 ? `${String(hour).padStart(2, '0')}:00×${n}` : null))
      .filter(Boolean)
      .join(' ');
    console.log(
      `   ${r.activity_date}  code ${(r.contravention_code ?? '(none)').padEnd(4)} ` +
        `${r.enforcement_class.padEnd(15)} ${String(r.pcn_count).padStart(5)} PCNs  ` +
        `${r.via_cctv === null ? 'mixed channel' : r.via_cctv ? 'camera' : 'on street'}`,
    );
    console.log(`   ${''.padEnd(12)} hours: ${hours || '(no times recorded)'}`);
  }

  /* 3. Totals and geography ----------------------------------------------- */

  const { rows: counts } = await pool.query<{
    total: string;
    rows_stored: string;
    histogrammed: string;
    earliest: string | null;
    latest: string | null;
    codes: string;
  }>(
    `select coalesce(sum(pcn_count), 0)::text as total,
            count(*)::text as rows_stored,
            coalesce(sum((select sum(h) from unnest(hour_histogram) h)), 0)::text as histogrammed,
            min(activity_date)::text as earliest,
            max(activity_date)::text as latest,
            count(distinct contravention_code)::text as codes
       from pcn_activity_daily
      where parking_location_id = $1 and dataset_version_id = pcnwatch_active_version('camden')`,
    [location.id],
  );
  const c = counts[0]!;

  console.log('\n3. AGGREGATED');
  console.log(`   notices counted      ${c.total}`);
  console.log(`   rows stored          ${c.rows_stored}`);
  console.log(
    `   compression          ${
      Number(c.rows_stored) > 0
        ? `${(Number(c.total) / Number(c.rows_stored)).toFixed(1)} notices per stored row`
        : '(no rows)'
    }`,
  );
  console.log(
    `   with a recorded time ${c.histogrammed} of ${c.total}` +
      `${Number(c.histogrammed) > Number(c.total) ? '  *** MORE HOURS THAN NOTICES ***' : ''}`,
  );
  console.log(`   date range           ${c.earliest ?? '(none)'} → ${c.latest ?? '(none)'}`);
  console.log(`   distinct codes       ${c.codes}`);
  console.log(`   location confidence  ${Number(location.data_confidence).toFixed(3)}`);
  // Source location versus derived geography: the street name is what the
  // authority published; the point is one notice's coordinate reused for the
  // whole street, which is a derivation and is labelled as one.
  console.log(`   has geometry         ${location.has_geom}`);
  console.log(`   geometry origin      ${location.geometry_source ?? '(none — never invented)'}`);
  console.log(`   geometry method      ${location.geometry_method ?? '(none)'}`);
  console.log(`   placed from record   ${location.geometry_reference_version ?? '(none)'}`);

  /* 4. Score -------------------------------------------------------------- */

  const { rows: stored } = await pool.query<{
    score: number | null;
    classification: string | null;
    refusal_reason: string | null;
    model_version: string;
    as_of_date: string;
  }>(
    `select score, classification, refusal_reason, model_version, as_of_date::text
     from pcn_activity_scores
     where parking_location_id = $1 and period_key = $2
     order by as_of_date desc limit 1`,
    [location.id, period],
  );

  const live = recomputed.get(location.id);

  console.log('\n4. TICKET ACTIVITY SCORE');
  if (stored[0]) {
    const s = stored[0];
    console.log(
      `   stored               ${s.score ?? '(refused)'}${s.classification ? ` ${classificationLabel(s.classification as never)}` : ''}  [${s.model_version}, as of ${s.as_of_date}]`,
    );
    if (s.refusal_reason) console.log(`   refusal              ${s.refusal_reason}`);
  } else {
    console.log('   stored               (none — scoring has not run for this period)');
  }

  if (live) {
    if (live.scored) {
      console.log(`   recomputed now       ${live.score} ${classificationLabel(live.classification)}`);
      console.log(`   confidence           ${live.dataConfidence}`);
      console.log(`   total PCNs in score  ${live.totalPcns}`);
      console.log('   components:');
      for (const comp of live.components) {
        console.log(
          `     ${comp.key.padEnd(8)} value ${comp.value.toFixed(3)} × weight ${comp.weight.toFixed(3)}`,
        );
      }
      if (stored[0]?.score !== null && stored[0]?.score !== undefined && stored[0].score !== live.score) {
        console.log(
          `   *** stored ${stored[0].score} differs from recomputed ${live.score} — scores are stale ***`,
        );
      }
    } else {
      console.log(`   recomputed now       REFUSED — ${live.reason}`);
      console.log(`   reason shown to user ${live.message}`);
    }
  }

  /* 5. What the UI shows -------------------------------------------------- */

  const { rows: ui } = await pool.query(
    'select * from pcnwatch_location_detail($1, $2)',
    ['camden', location.slug],
  );
  const u = ui[0];

  console.log('\n5. UI OUTPUT  (exactly what the hotspot page renders)');
  if (!u) {
    console.log('   (no row — the page would 404)');
    return;
  }
  console.log(`   total PCNs           ${u.total_pcns}`);
  console.log(`   dominant code        ${u.dominant_contravention ?? '(none)'}`);
  console.log(`   peak window          ${u.peak_window ?? '(no times recorded)'}`);
  console.log(`   score                ${u.score ?? `(none — ${u.refusal_reason ?? 'not computed'})`}`);
  console.log(`   data confidence      ${u.data_confidence}`);
  console.log(`   source               ${u.source_name ?? '(none)'}`);
  console.log(`   retrieved at         ${u.retrieved_at ?? '(none)'}`);

  const uiMatches = String(u.total_pcns) === c.total;
  console.log(
    `\n   VERDICT: UI total ${u.total_pcns} vs source-derived ${c.total} → ${
      uiMatches ? '✓ traces to source' : '✗ DOES NOT RECONCILE'
    }`,
  );
}

function indexed(value: unknown, length: number): number[] {
  const counts = Array.from({ length }, () => 0);
  if (value === null || typeof value !== 'object') return counts;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const i = Number(key);
    const n = Number(raw);
    if (Number.isInteger(i) && i >= 0 && i < length && Number.isFinite(n)) counts[i] = n;
  }
  return counts;
}

main().catch((error) => {
  console.error('\n✗ Trace failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
