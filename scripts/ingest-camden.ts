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

import { createCamdenAdapter, CAMDEN_AUTHORITY_SLUG, CamdenFetchError } from '../src/data-sources/camden/adapter';
import { runIngestion } from '../src/data-sources/shared/pipeline';
import { runCamdenIngestionJob, type IngestionJobResult } from '../src/server/ingestion/postgres/run';
import { analyseQuality, evaluateQualityGate } from '../src/server/ingestion/postgres/quality';
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

  const datasetUrl = args.sourceOverride ?? process.env.CAMDEN_PCN_DATASET_URL;
  const databaseUrl = process.env.DATABASE_URL;

  if (!datasetUrl) {
    fail(
      2,
      'CAMDEN_PCN_DATASET_URL is not set.',
      [
        'Set it to the JSON endpoint of Camden’s published PCN dataset, for example:',
        '  export CAMDEN_PCN_DATASET_URL="https://opendata.camden.gov.uk/resource/<dataset-id>.json"',
        '',
        'Run `npm run camden:probe` first to discover the dataset id and confirm its schema.',
      ],
    );
  }

  if (!args.dryRun && !databaseUrl) {
    fail(
      2,
      'DATABASE_URL is not set.',
      [
        'Set it to a PostgreSQL connection string for a database with PostGIS and the',
        'PCNWatch migrations applied, for example:',
        '  export DATABASE_URL="postgres://user:pass@localhost:5432/pcnwatch"',
        '',
        'Or run with --dry-run to validate the source without writing anything.',
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

    printReport(result, datasetUrl);

    if (result.status === 'FAILED') {
      console.error('\n✗ Ingestion failed. No data was written; previously ingested data is untouched.\n');
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
        return { inserted: 0, updated: 0, unchanged: events.length };
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
  );

  console.log('\nDRY RUN — nothing was written. Re-run without --dry-run to persist.\n');
  if (result.status === 'FAILED') process.exit(1);
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function printReport(result: IngestionJobResult, datasetUrl: string): void {
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
  row('Rows inserted', c.inserted);
  row('Rows updated', c.updated);
  row('Rows unchanged', c.unchanged);
  row('Duplicates in batch', c.duplicatesInBatch);
  row('Geolocated', c.geolocated);
  row('Not geolocated', c.notGeolocated);
  row('Errors recorded', c.errors);

  if (q) {
    section('LOCATION QUALITY');
    row('% geolocated', `${q.location.percentageGeolocated}%`);
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
      console.log(`  ${code.padEnd(34)} ${String(count).padStart(8)}`);
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
    for (const f of result.qualityGate.failures) console.log(`  ✗ ${f}`);
    for (const c2 of result.qualityGate.cautions) console.log(`  ! ${c2}`);
  }

  if (result.fatalError) {
    section('FATAL ERROR');
    console.log(`  ${result.fatalError}`);
  }
}

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
