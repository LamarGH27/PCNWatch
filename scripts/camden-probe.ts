/**
 * Camden dataset schema probe.
 *
 *   npm run camden:probe
 *   npm run camden:probe -- --url "https://opendata.camden.gov.uk/resource/<id>.json"
 *
 * Fetches a small sample of the live dataset and reports what is actually there:
 * every column, its inferred type, fill rate, sample values, and — crucially —
 * how the adapter's alias lists map onto it.
 *
 * This exists because a fixture is a guess about production. Rather than assume
 * the two match, this prints the evidence, so a mismatch is found before a full
 * ingestion rather than as a wall of rejected rows. Its output is safe to paste
 * into an issue: values are truncated and scrubbed of anything registration-shaped.
 */

import { FIELD_ALIASES, POINT_FIELD_CANDIDATES, readSocrataPoint } from '../src/data-sources/camden/schema';
import { redactRegistrations, isForbiddenField } from '../src/data-sources/shared/pii';
import { normaliseCamdenRow } from '../src/data-sources/camden/adapter';
import { classifyEnforcement } from '../src/data-sources/camden/enforcement-class';
import { execFileSync } from 'node:child_process';

const SAMPLE_SIZE = 50;

interface ColumnProfile {
  name: string;
  types: Set<string>;
  present: number;
  empty: number;
  samples: string[];
  looksLikePoint: boolean;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const urlIndex = argv.indexOf('--url');
  const datasetUrl = urlIndex >= 0 ? argv[urlIndex + 1] : process.env.CAMDEN_PCN_DATASET_URL;

  if (!datasetUrl) {
    console.error(
      '\n✗ No dataset URL.\n\n' +
        '  Pass one:      npm run camden:probe -- --url "https://opendata.camden.gov.uk/resource/<id>.json"\n' +
        '  Or set it:     export CAMDEN_PCN_DATASET_URL="..."\n\n' +
        '  To find the dataset id, open https://opendata.camden.gov.uk and search for the\n' +
        '  penalty charge notice dataset. The id is the 4x4 code in its API endpoint.\n',
    );
    process.exit(2);
  }

  const url = new URL(datasetUrl);
  url.searchParams.set('$limit', String(SAMPLE_SIZE));

  console.log(`\nProbing ${url.origin}${url.pathname}\n`);

  let response: Response;
  try {
    response = await fetch(url.toString(), {
      headers: {
        accept: 'application/json',
        ...(process.env.CAMDEN_APP_TOKEN ? { 'X-App-Token': process.env.CAMDEN_APP_TOKEN } : {}),
      },
    });
  } catch (error) {
    console.error(`✗ Could not reach the dataset: ${(error as Error).message}\n`);
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`✗ HTTP ${response.status} from the dataset endpoint.\n`);
    if (response.status === 404) {
      console.error('  A 404 usually means the dataset id is wrong or the dataset was retired.\n');
    }
    process.exit(1);
  }

  const payload = await response.json().catch(() => null);
  if (!Array.isArray(payload)) {
    console.error('✗ The endpoint did not return a JSON array of rows.');
    console.error(`  Received: ${typeof payload}\n`);
    process.exit(1);
  }
  if (payload.length === 0) {
    console.error('✗ The endpoint returned zero rows. Nothing to profile.\n');
    process.exit(1);
  }

  /* -- Column profile ------------------------------------------------------ */

  const columns = new Map<string, ColumnProfile>();
  for (const row of payload) {
    if (row === null || typeof row !== 'object') continue;
    for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
      const profile = columns.get(name) ?? {
        name,
        types: new Set<string>(),
        present: 0,
        empty: 0,
        samples: [],
        looksLikePoint: false,
      };
      profile.present += 1;
      if (value === null || value === undefined || String(value).trim() === '') profile.empty += 1;
      profile.types.add(Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value);
      if (readSocrataPoint(value)) profile.looksLikePoint = true;
      if (profile.samples.length < 3 && value !== null && String(value).trim() !== '') {
        profile.samples.push(safeSample(name, value));
      }
      columns.set(name, profile);
    }
  }

  console.log(`Sampled ${payload.length} rows, ${columns.size} columns.`);
  console.log(`Adapter build: ${adapterRevision()}\n`);
  console.log('COLUMNS');
  console.log('─'.repeat(100));
  console.log(
    `  ${'name'.padEnd(30)} ${'type'.padEnd(14)} ${'fill'.padEnd(7)} sample`,
  );
  for (const p of [...columns.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const fill = `${Math.round(((p.present - p.empty) / payload.length) * 100)}%`;
    const type = [...p.types].join('|') + (p.looksLikePoint ? ' (point)' : '');
    console.log(
      `  ${p.name.padEnd(30)} ${type.padEnd(14)} ${fill.padEnd(7)} ${p.samples.join(' · ').slice(0, 44)}`,
    );
  }

  /* -- Alias mapping ------------------------------------------------------- */

  console.log('\nADAPTER FIELD MAPPING');
  console.log('─'.repeat(100));
  const names = new Set(columns.keys());
  let missingRequired = 0;

  for (const [logical, aliases] of Object.entries(FIELD_ALIASES)) {
    const matched = aliases.filter((a) => names.has(a));
    const required = logical === 'recordId' || logical === 'street';
    const status = matched.length > 0 ? '✓' : required ? '✗ REQUIRED' : '– optional';
    if (matched.length === 0 && required) missingRequired += 1;
    console.log(
      `  ${status.padEnd(12)} ${logical.padEnd(20)} ${matched.length > 0 ? `→ ${matched.join(', ')}` : `(none of: ${aliases.slice(0, 4).join(', ')}…)`}`,
    );
  }

  const pointColumn = [...columns.values()].find((c) => c.looksLikePoint);
  console.log(
    `  ${(pointColumn ? '✓' : '– optional').padEnd(12)} ${'coordinates'.padEnd(20)} ${
      pointColumn
        ? `→ nested point in "${pointColumn.name}"`
        : names.has('longitude') && names.has('latitude')
          ? '→ scalar longitude/latitude'
          : `(no point column; looked for: ${POINT_FIELD_CANDIDATES.slice(0, 4).join(', ')}…)`
    }`,
  );

  /* -- Enforcement mix and precision claim --------------------------------- */

  // Learned from the sample rather than assumed. Camden's dataset is not a
  // parking dataset: the live sample contains `MTC` (moving traffic). Anything
  // presented as a count needs to say which enforcement classes it covers.
  console.log('\nENFORCEMENT MIX (from the sample)');
  console.log('─'.repeat(100));
  const ticketTypeCounts = countDistinct(payload, 'ticket_type');
  if (ticketTypeCounts.size === 0) {
    console.log('  (no ticket_type column in this dataset)');
  } else {
    for (const [value, count] of sortedByCount(ticketTypeCounts)) {
      const c = classifyEnforcement(value);
      console.log(
        `  ${value.padEnd(24)} ${String(count).padStart(4)}  → ${c.enforcementClass}${c.recognised ? '' : '  ✗ UNRECOGNISED — classify before ingesting'}`,
      );
    }
  }

  const cctvCounts = countDistinct(payload, 'ticket_issued_via_cctv_camera');
  if (cctvCounts.size > 0) {
    console.log('\n  Issued via CCTV camera:');
    for (const [value, count] of sortedByCount(cctvCounts)) {
      console.log(`    ${value.padEnd(22)} ${String(count).padStart(4)}`);
    }
  }

  console.log('\nPRECISION THE PUBLISHER CLAIMS');
  console.log('─'.repeat(100));
  const accuracyCounts = countDistinct(payload, 'spatial_accuracy');
  if (accuracyCounts.size === 0) {
    console.log('  (no spatial_accuracy column; the publisher makes no precision claim)');
  } else {
    for (const [value, count] of sortedByCount(accuracyCounts)) {
      console.log(`  ${value.padEnd(24)} ${String(count).padStart(4)}`);
    }
    console.log(
      '  This is the publisher\'s own claim about how precisely a notice is located.',
    );
    console.log('  The product may not claim precision finer than this value.');
  }

  /* -- Dry normalisation --------------------------------------------------- */

  console.log('\nNORMALISATION OF THE SAMPLE');
  console.log('─'.repeat(100));
  let accepted = 0;
  const failures = new Map<string, number>();
  let geolocated = 0;
  for (const [i, row] of payload.entries()) {
    const result = normaliseCamdenRow(row, i);
    if (result.ok) {
      accepted += 1;
      if (result.event.longitude !== null) geolocated += 1;
    } else {
      failures.set(result.error.errorCode, (failures.get(result.error.errorCode) ?? 0) + 1);
    }
  }
  console.log(`  accepted        ${accepted}/${payload.length}`);
  console.log(`  geolocated      ${geolocated}/${accepted}`);
  for (const [code, count] of [...failures.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  rejected        ${code}: ${count}`);
  }

  /* -- Verdict ------------------------------------------------------------- */

  console.log('\nVERDICT');
  console.log('─'.repeat(100));
  const acceptRate = accepted / payload.length;

  if (missingRequired > 0) {
    console.log('  ✗ The adapter cannot read this dataset: a required field has no matching column.');
    console.log('');
    // Print the alias lists this build actually compiled in. A required field
    // failing while the obvious column sits in the source usually means the
    // checkout predates the fix, not that the fix is wrong — and the two look
    // identical from the summary line above. This makes them look different.
    for (const logical of ['recordId', 'street'] as const) {
      const aliases = FIELD_ALIASES[logical];
      if (aliases.some((a) => names.has(a))) continue;
      console.log(`    ${logical} — this build looks for, in order:`);
      console.log(`      ${aliases.join(', ')}`);
      console.log(`    The source published: ${[...names].sort().join(', ')}`);
      const obvious = [...names].filter((n) => !Object.values(FIELD_ALIASES).some((l) => (l as readonly string[]).includes(n)));
      if (obvious.length > 0) {
        console.log(`    Columns no alias list mentions: ${obvious.join(', ')}`);
      }
      console.log('');
    }
    console.log(`    Adapter build: ${adapterRevision()}`);
    console.log('    If a column above is plainly the right one, this checkout is behind —');
    console.log('    pull the branch and re-run before editing FIELD_ALIASES.');
    console.log('    Otherwise add the real column name to FIELD_ALIASES in');
    console.log('    src/data-sources/camden/schema.ts.');
  } else if (acceptRate < 0.8) {
    console.log(`  ✗ Only ${Math.round(acceptRate * 100)}% of the sample normalised successfully.`);
    console.log('    Fix the rejections above before attempting a full ingestion.');
  } else if (geolocated === 0) {
    const publishesCoordinates =
      names.has('longitude') || names.has('latitude') || pointColumn !== undefined;
    if (publishesCoordinates) {
      console.log('  ! Rows normalise, but no coordinate could be read from the columns that exist.');
      console.log('    That is an adapter or format problem — fix it before ingesting.');
    } else {
      console.log('  ! Rows normalise. This dataset publishes no coordinates at all.');
      console.log('    Street names, dates and contravention codes are intact and worth ingesting;');
      console.log('    nothing can be placed on a map until a street-reference dataset is loaded.');
      console.log('    See docs/geography.md. No position will be invented in the meantime.');
    }
  } else {
    console.log(`  ✓ The adapter reads this dataset. ${Math.round(acceptRate * 100)}% of the sample`);
    console.log(`    normalised, ${Math.round((geolocated / accepted) * 100)}% with coordinates.`);
    console.log('\n    Next: npm run ingest:camden -- --dry-run --limit 5000');
  }
  console.log('');

  process.exit(missingRequired > 0 || acceptRate < 0.8 ? 1 : 0);
}

/**
 * Which build of the adapter produced this output.
 *
 * A probe result is evidence, and evidence needs to say what it is evidence
 * about. Best-effort: outside a git checkout it says so rather than guessing.
 */
function adapterRevision(): string {
  try {
    const rev = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const dirty =
      execFileSync('git', ['status', '--porcelain'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() !== '';
    return `${rev}${dirty ? ' (uncommitted changes present)' : ''}`;
  } catch {
    return 'unknown (not a git checkout)';
  }
}

/** Distinct non-empty values of one column across the sample, with counts. */
function countDistinct(rows: readonly unknown[], column: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const value = (row as Record<string, unknown>)[column];
    if (value === null || value === undefined) continue;
    const key = String(value).trim();
    if (key === '') continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sortedByCount(counts: Map<string, number>): [string, number][] {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** Truncated, scrubbed sample value — safe to paste into an issue. */
function safeSample(name: string, value: unknown): string {
  if (isForbiddenField(name)) return '[redacted field]';
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value).slice(0, 40);
  }
  return redactRegistrations(String(value)).slice(0, 24);
}

main().catch((error) => {
  console.error('\n✗ Probe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
