/**
 * Source traceability.
 *
 *   npm run camden:trace                 # top 5 locations by activity
 *   npm run camden:trace -- --limit 10
 *   npm run camden:trace -- --slug eversholt-street
 *
 * For each location, walks the whole chain and prints it:
 *
 *   RAW SOURCE ROWS → NORMALISED EVENTS → AGGREGATES → SCORE → WHAT THE UI SHOWS
 *
 * The point is to make a displayed number falsifiable. Every figure on a hotspot
 * page should be reconstructible from the rows printed here; if a count does not
 * reconcile, this prints the discrepancy rather than the pretty number.
 *
 * Requires DATABASE_URL.
 */

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
      raw_count: string;
    }>(
      `select l.id, l.slug, l.display_name, l.data_confidence,
              l.geom is not null as has_geom,
              count(e.id)::text as raw_count
       from parking_locations l
       join authorities a on a.id = l.authority_id and a.slug = 'camden'
       left join pcn_events e on e.parking_location_id = l.id
       ${args.slug ? 'where l.slug = $2' : ''}
       group by l.id
       order by count(e.id) desc
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
      'select * from pcnwatch_scoring_inputs($1)',
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
    raw_count: string;
  },
  recomputed: Map<string, ReturnType<typeof computeTicketActivityScores>[number]>,
  period: string,
  asOf: string,
): Promise<void> {
  console.log(`\n\n${'='.repeat(96)}`);
  console.log(`LOCATION  ${location.display_name}   (/hotspots/camden/${location.slug})`);
  console.log('='.repeat(96));

  /* 1. Raw source rows ---------------------------------------------------- */

  const { rows: sample } = await pool.query<{
    source_record_id: string;
    issued_date: string;
    issued_hour: number | null;
    contravention_code: string | null;
    source_metadata: Record<string, unknown>;
    lon: number | null;
    lat: number | null;
  }>(
    `select source_record_id, issued_date::text, issued_hour, contravention_code, source_metadata,
            st_x(geom::geometry) as lon, st_y(geom::geometry) as lat
     from pcn_events where parking_location_id = $1
     order by issued_date desc limit 3`,
    [location.id],
  );

  console.log('\n1. SOURCE  (3 most recent stored events, with the columns they came from)');
  for (const s of sample) {
    const resolved = (s.source_metadata as { _resolvedFields?: Record<string, string> })._resolvedFields;
    console.log(
      `   ${s.source_record_id.padEnd(16)} ${s.issued_date} ${
        s.issued_hour === null ? '--:00' : `${String(s.issued_hour).padStart(2, '0')}:00`
      }  code ${s.contravention_code ?? '(none)'}  ${
        s.lon === null ? 'no coords' : `${s.lon.toFixed(5)},${s.lat!.toFixed(5)}`
      }`,
    );
    if (resolved) {
      console.log(
        `   ${''.padEnd(16)} from columns: id=${resolved.recordId} street=${resolved.street} date=${resolved.date} coords=${resolved.coordinates ?? 'none'}`,
      );
    }
  }

  /* 2. Normalised event counts -------------------------------------------- */

  const { rows: counts } = await pool.query<{
    total: string;
    geolocated: string;
    earliest: string;
    latest: string;
    codes: string;
  }>(
    `select count(*)::text as total,
            count(geom)::text as geolocated,
            min(issued_date)::text as earliest,
            max(issued_date)::text as latest,
            count(distinct contravention_code)::text as codes
     from pcn_events where parking_location_id = $1`,
    [location.id],
  );
  const c = counts[0]!;

  console.log('\n2. NORMALISED');
  console.log(`   stored events        ${c.total}`);
  console.log(`   geolocated           ${c.geolocated}`);
  console.log(`   date range           ${c.earliest} → ${c.latest}`);
  console.log(`   distinct codes       ${c.codes}`);
  console.log(`   location confidence  ${Number(location.data_confidence).toFixed(3)}`);
  console.log(`   has geometry         ${location.has_geom}`);

  /* 3. Aggregates --------------------------------------------------------- */

  const { rows: agg } = await pool.query<{ bucket_kind: string; total: string; buckets: string }>(
    `select bucket_kind, sum(pcn_count)::text as total, count(*)::text as buckets
     from pcn_activity_aggregates where parking_location_id = $1
     group by bucket_kind order by bucket_kind`,
    [location.id],
  );

  console.log('\n3. AGGREGATES');
  for (const a of agg) {
    console.log(`   ${a.bucket_kind.padEnd(12)} ${a.buckets.padStart(4)} buckets, ${a.total.padStart(8)} PCNs`);
  }

  const monthTotal = agg.find((a) => a.bucket_kind === 'MONTH')?.total;
  const reconciles = monthTotal === c.total;
  console.log(
    `   reconciliation       MONTH aggregate ${monthTotal ?? '(none)'} vs stored events ${c.total} → ${
      reconciles ? 'MATCH' : '*** MISMATCH ***'
    }`,
  );

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
