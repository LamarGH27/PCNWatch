/**
 * Camden PCN ingestion.
 *
 *   npm run ingest:camden                    # real source → database
 *   npm run ingest:camden -- --dry-run       # fetch + validate, write nothing
 *   npm run ingest:camden -- --limit 5000    # bounded first run
 *   npm run ingest:camden -- --since 2025-01-01
 *
 * Requires CAMDEN_PCN_DATASET_URL and DATABASE_URL. It refuses to run without
 * them rather than falling back to anything, and never substitutes fixture data
 * for the real source.
 *
 * Exit codes:
 *   0  ingestion succeeded (possibly with rejected rows, which are reported)
 *   1  ingestion materially failed, or the data-quality gate did not pass
 *   2  not configured — nothing was attempted
 */

import './load-env';
import {
  createCamdenAdapter,
  CAMDEN_AUTHORITY_SLUG,
  CamdenFetchError,
  camdenDatasetUrl,
} from '../src/data-sources/camden/adapter';
import { runIngestion } from '../src/data-sources/shared/pipeline';
import { runCamdenIngestionJob, type IngestionJobResult } from '../src/server/ingestion/postgres/run';
import {
  analyseQuality,
  evaluateQualityGate,
  type MapReadiness,
} from '../src/server/ingestion/postgres/quality';
import { knownContraventionCodes } from '../src/core/reference/store';
import type { IngestionError, NormalisedPcnEvent } from '../src/data-sources/shared/types';

interface Args {
  limit?: number;
  since?: string;
  dryRun: boolean;
  /**
   * Points the adapter at a non-official URL. Any run using it is recorded as
   * demo, so the coverage layer refuses to present the result as real data.
   */
  sourceOverride?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--since') args.since = argv[++i];
    else if (flag === '--source-override') args.sourceOverride = argv[++i];
    else {
      // Silently ignoring an unknown flag is how `--source` gets typed for
      // `--source-override` and the run quietly hits the real dataset instead.
      console.error(`\n✗ Unknown option: ${flag}\n`);
      console.error('  Valid options: --dry-run, --limit <n>, --since <YYYY-MM-DD>,');
      console.error('                 --source-override <url>\n');
      process.exit(2);
    }
  }
  return args;
}

const OFFICIAL_HOST = 'opendata.camden.gov.uk';

function isOfficialSource(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(OFFICIAL_HOST);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const datasetUrl = args.sourceOverride ?? camdenDatasetUrl();
  const databaseUrl = process.env.DATABASE_URL;

  if (!args.dryRun && !databaseUrl) {
    fail(
      2,
      'DATABASE_URL is not set.',
      [
        'A dry run needs no database:',
        '  npm run ingest:camden -- --dry-run --limit 5000',
        '',
        'To write, you need PostgreSQL 15+ with PostGIS. If you have Docker:',
        '  docker run -d --name pcnwatch-db -p 5432:5432 \\',
        '    -e POSTGRES_PASSWORD=postgres postgis/postgis:16-3.4',
        '  export PGHOST=localhost PGUSER=postgres PGPASSWORD=postgres',
        '  npm run db:setup',
        '  echo \'DATABASE_URL="postgres://postgres:postgres@localhost:5432/pcnwatch"\' >> .env.local',
        '',
        'Anything in .env.local is picked up automatically on the next run.',
      ],
    );
  }

  const official = isOfficialSource(datasetUrl);
  const isDemo = !official;

  if (isDemo) {
    console.warn(
      `\n⚠  ${datasetUrl} is not Camden's official open-data host.\n` +
        '   This run will be recorded as DEMO data. The map and hotspot pages will\n' +
        '   refuse to present it as real enforcement activity.\n',
    );
  }

  const adapter = createCamdenAdapter({
    datasetUrl,
    onProgress: ({ page, rowsSoFar }) => {
      // A fetch of a full borough takes minutes. Silence for that long is
      // indistinguishable from a hang.
      process.stdout.write(`\r  fetching… page ${page}, ${rowsSoFar.toLocaleString('en-GB')} rows`);
    },
    appToken: process.env.CAMDEN_APP_TOKEN,
  });

  try {
    if (args.dryRun) {
      await dryRun(adapter, args, datasetUrl);
      return;
    }

    const result = await runCamdenIngestionJob(adapter, {
      connectionString: databaseUrl as string,
      authoritySlug: CAMDEN_AUTHORITY_SLUG,
      since: args.since,
      limit: args.limit,
      triggerSource: 'cli',
      isDemo,
    });

    printReport(result, datasetUrl, { limit: args.limit });

    if (result.status === 'FAILED') {
      if (result.committed) {
        // The write transaction committed and something after it failed —
        // quality analysis, the aggregate rebuild or scoring. Claiming nothing
        // was written would be the worst kind of wrong to be about a write.
        console.error(
          '\n✗ Ingestion failed AFTER the events were committed.\n' +
            '  The PCN events are in the database. What follows them — aggregates and\n' +
            '  Ticket Activity Scores — may be missing or stale, so the site could show\n' +
            '  figures that do not match the events behind them. Re-run to rebuild them.\n',
        );
      } else {
        console.error(
          '\n✗ Ingestion failed. No data was written; previously ingested data is untouched.\n',
        );
      }
      process.exit(1);
    }
    if (result.qualityGate && !result.qualityGate.pass) {
      console.error(
        '\n✗ Data was ingested, but the quality gate did not pass. The figures above are\n' +
          '  real, and are not good enough to present as enforcement intelligence yet.\n',
      );
      process.exit(1);
    }
    console.log('\n✓ Ingestion complete.\n');
  } catch (error) {
    if (error instanceof CamdenFetchError) {
      console.error(`\n✗ Could not fetch the Camden dataset (${error.code}): ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

/** Validates the source without touching the database. */
async function dryRun(
  adapter: ReturnType<typeof createCamdenAdapter>,
  args: Args,
  datasetUrl: string,
): Promise<void> {
  const accepted: NormalisedPcnEvent[] = [];
  const errors: IngestionError[] = [];
  const startedAt = Date.now();

  const result = await runIngestion(
    adapter,
    {
      async upsertEvents(events) {
        accepted.push(...events);
        // Nothing is compared against stored rows in a dry run, so every write
        // counter stays zero. Reporting these as "unchanged" claimed they had
        // been found identical to existing records, which is a different and
        // untrue statement.
        return { inserted: 0, updated: 0, unchanged: 0 };
      },
      async recordErrors(rejected) {
        errors.push(...rejected);
      },
    },
    { since: args.since, limit: args.limit, maxRejectionRate: 1 },
  );

  const today = new Date().toISOString().slice(0, 10);
  const quality = analyseQuality(accepted, errors, new Set(knownContraventionCodes()), today);
  const gate = evaluateQualityGate(quality, result.report.fetched, result.report.rejected);

  printReport(
    {
      runId: '(dry run)',
      status: result.status,
      message: result.message,
      sourceUrl: datasetUrl,
      versionLabel: result.versionLabel,
      contentHash: result.contentHash,
      retrievedAt: result.retrievedAt,
      durationMs: Date.now() - startedAt,
      isDemo: !isOfficialSource(datasetUrl),
      counters: {
        ...result.report,
        duplicatesInBatch: errors.filter((e) => e.errorCode === 'DUPLICATE_IN_BATCH').length,
      },
      warningCounts: result.warningCounts,
      quality,
      qualityGate: gate,
      scoreDistributions: [],
      fatalError: null,
    },
    datasetUrl,
    { dryRun: true, limit: args.limit },
  );

  console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to persist.\n');
  if (result.status === 'FAILED') process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function printReport(
  result: IngestionJobResult,
  datasetUrl: string,
  options: { dryRun?: boolean; limit?: number } = {},
): void {
  const c = result.counters;
  const q = result.quality;

  section('SOURCE');
  row('URL', datasetUrl);
  row('Official source', result.isDemo ? 'NO — recorded as DEMO' : 'yes');
  row('Version label', result.versionLabel || '(none)');
  row('Content hash', result.contentHash ? result.contentHash.slice(0, 16) : '(none)');
  row('Fetched at', result.retrievedAt);
  row('Run id', result.runId);
  row('Status', result.status);
  row('Duration', `${(result.durationMs / 1000).toFixed(1)}s`);

  section('INGESTION');
  row('Rows fetched', c.fetched);
  row('Rows accepted', c.accepted);
  row('Rows rejected', c.rejected);
  if (options.dryRun) {
    row('Rows written', 'none — dry run, nothing compared against stored data');
  } else {
    row('Rows inserted', c.inserted);
    row('Rows updated', c.updated);
    row('Rows unchanged', c.unchanged);
  }
  row('Duplicates in batch', c.duplicatesInBatch);
  row('Geolocated', c.geolocated);
  row('Not geolocated', c.notGeolocated);
  row('Errors recorded', c.errors);

  if (q) {
    section('LOCATION QUALITY');
    row('Source geography', q.location.geographyAvailability);
    row('% geolocated', `${q.location.percentageGeolocated}%`);
    for (const [reason, count] of Object.entries(q.location.noGeometryReasons).sort(
      (a, b) => b[1] - a[1],
    )) {
      row(`  no geometry — ${reason}`, count);
    }
    row('Unique locations', q.location.uniqueLocations);
    row('Unique coordinate pairs', q.location.uniqueCoordinatePairs);
    row('Shared coordinate pairs', q.location.sharedCoordinatePairs);
    row('Largest coordinate cluster', q.location.largestCoordinateCluster);
    row('Outside Camden bounds', q.location.outsideBounds);
    row('Vague location names', q.location.vagueLocations);
    if (q.location.vagueExamples.length > 0) {
      row('  examples', q.location.vagueExamples.join(', '));
    }

    section('TEMPORAL QUALITY');
    row('Earliest PCN date', q.temporal.earliestDate ?? '(none)');
    row('Latest PCN date', q.temporal.latestDate ?? '(none)');
    row('Span (days)', q.temporal.spanDays ?? '(none)');
    row('Distinct months', q.temporal.distinctMonths);
    row('With time of day', q.temporal.withTime);
    row('Without time of day', q.temporal.withoutTime);
    row('Future dates', q.temporal.futureDates);
    row('Implausibly old', q.temporal.implausiblyOld);

    if (options.limit !== undefined) {
    section('READ THIS BEFORE TRUSTING THE DISTRIBUTIONS BELOW');
    console.log(
      `  --limit ${options.limit} took the FIRST ${options.limit} rows in the source's own\n` +
        '  order, not a random sample. Socrata returns rows ordered by :id, which for\n' +
        '  Camden groups notices of the same kind together — so the contravention mix,\n' +
        '  the enforcement mix, the street list and the date range below describe that\n' +
        '  slice of the dataset, not the dataset. Only a full run gives real proportions.',
    );
  }

  section('CONTRAVENTION QUALITY');
    row('With code', q.contravention.withCode);
    row('Without code', q.contravention.withoutCode);
    row('Unique codes', q.contravention.uniqueCodes);
    row('Codes with no reference', q.contravention.unknownCodes.join(', ') || '(none)');
    if (q.contravention.codes.length > 0) {
      console.log('\n  Top codes:');
      for (const { code, count } of q.contravention.codes.slice(0, 10)) {
        console.log(`    ${code.padEnd(6)} ${String(count).padStart(8)}`);
      }
    }

    section('DUPLICATES');
    row('Repeated source ids', q.duplicates.repeatedSourceIds);
    row('Same street/time/code, different id', q.duplicates.identicalContentDifferentId);

    if (Object.keys(q.rejections).length > 0) {
      section('REJECTIONS BY REASON');
      for (const [code, count] of Object.entries(q.rejections).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${code.padEnd(34)} ${String(count).padStart(8)}`);
      }
    }
  }

  if (Object.keys(result.warningCounts).length > 0) {
    section('NORMALISATION WARNINGS');
    for (const [code, count] of Object.entries(result.warningCounts).sort((a, b) => b[1] - a[1])) {
      // A warning on every single accepted row is telling you about the shape of
      // the dataset, not about anything unusual in it. Left unlabelled, five
      // thousand of them reads like five thousand problems and buries the one
      // warning that fired on three rows.
      const everyRow = c.accepted > 0 && count === c.accepted;
      console.log(
        `  ${code.padEnd(34)} ${String(count).padStart(8)}` +
          (everyRow ? '   (every row — a property of the source schema)' : ''),
      );
    }
  }

  if (result.scoreDistributions.length > 0) {
    section('TICKET ACTIVITY SCORE DISTRIBUTION');
    for (const d of result.scoreDistributions) {
      console.log(`\n  Period ${d.periodKey}: ${d.scored} scored, ${d.refused} refused`);
      if (d.scored > 0) {
        console.log(
          `    min ${d.min}  p25 ${d.p25}  median ${d.median}  p75 ${d.p75}  max ${d.max}  mean ${d.mean}`,
        );
        const bands = ['VERY_LOW', 'LOW', 'MODERATE', 'HIGH', 'VERY_HIGH'];
        console.log(
          '    ' + bands.map((b) => `${b.toLowerCase()}: ${d.byClassification[b] ?? 0}`).join('  '),
        );
      }
      for (const [reason, count] of Object.entries(d.refusalsByReason)) {
        console.log(`    refused — ${reason}: ${count}`);
      }
    }
  }

  if (q && q.warnings.length > 0) {
    section('WARNINGS');
    for (const w of q.warnings) console.log(`  • ${w}`);
  }

  if (result.qualityGate) {
    section('DATA QUALITY GATE');
    row('Result', result.qualityGate.pass ? 'PASS' : 'FAIL');
    row('Map readiness', MAP_READINESS_LABELS[result.qualityGate.mapReadiness]);
    for (const f of result.qualityGate.failures) console.log(`  ✗ ${f}`);
    for (const c2 of result.qualityGate.cautions) console.log(`  ! ${c2}`);
  }

  if (result.fatalError) {
    section('FATAL ERROR');
    console.log(`  ${result.fatalError}`);
    // A bare "Maximum call stack size exceeded" says nothing about where it
    // happened, and a long ingestion is an expensive thing to re-run blind.
    if (result.fatalStack) {
      console.log('');
      for (const line of result.fatalStack.split('\n').slice(1, 12)) {
        console.log(`  ${line.trim()}`);
      }
    }
  }
}

const MAP_READINESS_LABELS: Readonly<Record<MapReadiness, string>> = {
  READY: 'READY — enough positioned records to draw the map',
  SPARSE: 'SPARSE — too few records positioned for a map worth showing',
  NO_SOURCE_GEOGRAPHY:
    'NO SOURCE GEOGRAPHY — the dataset publishes no coordinates; needs a street reference, not a fix',
  GEOGRAPHY_UNREADABLE:
    'GEOGRAPHY UNREADABLE — coordinates are published but none could be read; needs an adapter fix',
};

function section(title: string): void {
  console.log(`\n${title}\n${'─'.repeat(Math.max(title.length, 46))}`);
}

function row(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(34)} ${String(value)}`);
}

function fail(code: number, headline: string, lines: readonly string[]): never {
  console.error(`\n✗ ${headline}\n`);
  for (const line of lines) console.error(`  ${line}`);
  console.error('');
  process.exit(code);
}

main().catch((error) => {
  console.error('\n✗ Ingestion aborted:', error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(error.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(1);
});
