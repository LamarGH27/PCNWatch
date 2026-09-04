/**
 * Camden ingestion CLI.
 *
 *   npm run ingest:camden -- --limit 5000
 *   npm run ingest:camden -- --since 2025-01-01
 *   npm run ingest:camden -- --dry-run
 *
 * Requires CAMDEN_PCN_DATASET_URL and the Supabase service credentials. Without
 * them it refuses and says which are missing, rather than pretending to succeed.
 */

import { createCamdenAdapter, CAMDEN_AUTHORITY_SLUG, CamdenFetchError } from '../src/data-sources/camden/adapter';
import { runIngestionJob } from '../src/server/ingestion/supabase-sink';
import { runScoringJob } from '../src/server/ingestion/scoring-job';
import { integrationStatuses } from '../src/lib/env';
import { runIngestion } from '../src/data-sources/shared/pipeline';
import type { IngestionReport } from '../src/data-sources/shared/types';

interface Args {
  limit?: number;
  since?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--limit') args.limit = Number(argv[++i]);
    else if (flag === '--since') args.since = argv[++i];
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const statuses = integrationStatuses();
  const camden = statuses.find((s) => s.name === 'camden');
  const supabase = statuses.find((s) => s.name === 'supabase');

  if (!camden?.configured) {
    console.error(
      `\nCannot ingest: the Camden dataset is not configured.\n` +
        `Missing: ${camden?.missing.join(', ')}\n\n` +
        `Set CAMDEN_PCN_DATASET_URL to the dataset's JSON endpoint, then re-run.\n`,
    );
    process.exit(2);
  }

  if (!args.dryRun && !supabase?.configured) {
    console.error(
      `\nCannot ingest: Supabase is not configured.\n` +
        `Missing: ${supabase?.missing.join(', ')}\n\n` +
        `Run with --dry-run to validate the source without writing anything.\n`,
    );
    process.exit(2);
  }

  const adapter = createCamdenAdapter({
    datasetUrl: process.env.CAMDEN_PCN_DATASET_URL,
    appToken: process.env.CAMDEN_APP_TOKEN,
  });

  try {
    if (args.dryRun) {
      // Validates and normalises everything, writes nothing.
      const result = await runIngestion(
        adapter,
        {
          async upsertEvents(events) {
            return { inserted: 0, updated: 0, unchanged: events.length };
          },
          async recordErrors() {},
        },
        { since: args.since, limit: args.limit, maxRejectionRate: 1 },
      );
      report('DRY RUN', result.status, result.report, result.warningCounts, result.message);
      console.log('\nNothing was written. Re-run without --dry-run to persist.\n');
      return;
    }

    const result = await runIngestionJob(adapter, CAMDEN_AUTHORITY_SLUG, {
      since: args.since,
      limit: args.limit,
      triggerSource: 'cli',
    });
    report('INGESTION', result.status, result.report, result.warningCounts, result.message);

    if (result.status === 'FAILED') {
      console.error('\nIngestion failed. No aggregates or scores were recomputed.\n');
      process.exit(1);
    }

    for (const period of ['30D', '90D', '12M'] as const) {
      const scoring = await runScoringJob(CAMDEN_AUTHORITY_SLUG, period);
      console.log(
        `Scores (${period}): ${scoring.scored} scored, ${scoring.refused} refused ` +
          `(${Object.entries(scoring.refusalsByReason)
            .map(([reason, count]) => `${reason}: ${count}`)
            .join(', ') || 'none'})`,
      );
    }
    console.log('\nDone.\n');
  } catch (error) {
    if (error instanceof CamdenFetchError) {
      console.error(`\nCould not fetch the Camden dataset (${error.code}): ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }
}

function report(
  title: string,
  status: string,
  counters: IngestionReport,
  warnings: Readonly<Record<string, number>>,
  message: string,
): void {
  console.log(`\n${title} — ${status}\n${'─'.repeat(46)}`);
  for (const [key, value] of Object.entries(counters as unknown as Record<string, number>)) {
    console.log(`  ${key.padEnd(16)} ${String(value).padStart(8)}`);
  }
  if (Object.keys(warnings).length > 0) {
    console.log('\n  Warnings:');
    for (const [key, value] of Object.entries(warnings)) {
      console.log(`    ${key.padEnd(34)} ${String(value).padStart(6)}`);
    }
  }
  console.log(`\n  ${message}`);
}

main().catch((error) => {
  console.error('\nIngestion aborted:', error instanceof Error ? error.message : error);
  process.exit(1);
});
