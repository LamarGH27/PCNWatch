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

import './load-env';
import { FIELD_ALIASES, POINT_FIELD_CANDIDATES, readSocrataPoint } from '../src/data-sources/camden/schema';
import {
  redactRegistrations,
  isForbiddenField,
  redactionContextFor,
} from '../src/data-sources/shared/pii';
import { camdenDatasetUrl, normaliseCamdenRow } from '../src/data-sources/camden/adapter';
import { classifyEnforcement } from '../src/data-sources/camden/enforcement-class';
import { publisherClaimsPrecision } from '../src/core/geography/types';
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
  const datasetUrl = urlIndex >= 0 ? argv[urlIndex + 1] : camdenDatasetUrl();

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
  const pairs = countDistinctPairs(payload, 'ticket_type', 'ticket_description');
  if (pairs.size === 0) {
    console.log('  (no ticket_type column in this dataset)');
  } else {
    for (const [key, entry] of sortedPairs(pairs)) {
      void key;
      // Classified the way the adapter classifies, including the contravention
      // description, so the probe cannot report a class the pipeline would not.
      // Counted per row rather than from one representative: a ticket type whose
      // rows resolve to different classes must not be summarised as one class.
      const classCounts = new Map<string, number>();
      for (const row of payload) {
        if (typeof row !== 'object' || row === null) continue;
        const record = row as Record<string, unknown>;
        if (String(record['ticket_type'] ?? '').trim() !== entry.type) continue;
        const cls = classifyEnforcement(
          entry.type,
          entry.description,
          undefined,
          record['contravention_code_description'],
        ).enforcementClass;
        classCounts.set(cls, (classCounts.get(cls) ?? 0) + 1);
      }
      const classes = new Set(classCounts.keys());
      const unresolved = classCounts.get('UNKNOWN') ?? 0;
      const summary = sortedByCount(classCounts)
        .map(([cls, n]) => `${cls} ${n}`)
        .join(', ');
      console.log(
        `  ${entry.type.padEnd(14)} ${String(entry.count).padStart(4)}  → ${summary}${
          unresolved > 0 ? `  ✗ ${unresolved} UNRESOLVED — classify before ingesting` : ''
        }`,
      );
      console.log(
        `    description: ${entry.description === null ? '(none)' : JSON.stringify(entry.description)}`,
      );
      if (classes.size > 1) {
        console.log(
          "    ! rows of this type do not all mean the same thing — the class comes from",
        );
        console.log("      each row's contravention description, not from the type.");
      }
    }
  }

  // The contravention description is what resolves a ticket type the source does
  // not spell out, so show it grouped by type: the classification above should be
  // readable straight off these rows rather than taken on trust.
  console.log('\n  Contravention descriptions behind each ticket type:');
  const byType = new Map<string, Map<string, number>>();
  for (const row of payload) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const type = String(record['ticket_type'] ?? '(none)').trim() || '(none)';
    const code = String(record['contravention_code'] ?? '?').trim();
    const description = String(record['contravention_code_description'] ?? '').trim();
    const label = `${code} — ${description || '(no description)'}`;
    const inner = byType.get(type) ?? new Map<string, number>();
    inner.set(label, (inner.get(label) ?? 0) + 1);
    byType.set(type, inner);
  }
  for (const [type, inner] of [...byType.entries()].sort()) {
    console.log(`    ${type}`);
    for (const [label, count] of sortedByCount(inner).slice(0, 8)) {
      console.log(`      ${String(count).padStart(3)}  ${label.slice(0, 78)}`);
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
    const claims = [...accuracyCounts.keys()].filter((v) => publisherClaimsPrecision(v));
    if (claims.length === 0) {
      console.log('');
      console.log('  The publisher makes no precision claim for any row in this sample.');
      console.log('  We therefore have a street name and no stated idea how precisely it');
      console.log('  locates the notice. No precision may be claimed by the product either.');
    } else {
      console.log('');
      console.log("  This is the publisher's own claim about how precisely a notice is located.");
      console.log('  The product may not claim precision finer than this value.');
    }
  }

  /* -- Geography census across the whole dataset ---------------------------- */

  // The column list above comes from 50 rows. Socrata omits null fields per row,
  // so a column that is null in those 50 does not appear at all — which is how a
  // dataset that does publish coordinates can look like one that does not. Ask
  // the whole dataset directly instead of inferring from a sample.
  console.log('\nGEOGRAPHY ACROSS THE WHOLE DATASET');
  console.log('─'.repeat(100));
  const geoColumns = ['latitude', 'longitude', ...POINT_FIELD_CANDIDATES];
  let anyGeography = false;
  for (const column of geoColumns) {
    const countUrl = new URL(datasetUrl);
    countUrl.searchParams.set('$select', 'count(*) as n');
    countUrl.searchParams.set('$where', `${column} IS NOT NULL`);
    try {
      const response = await fetch(countUrl.toString(), {
        headers: {
          accept: 'application/json',
          ...(process.env.CAMDEN_APP_TOKEN ? { 'X-App-Token': process.env.CAMDEN_APP_TOKEN } : {}),
        },
      });
      if (!response.ok) {
        // A 400 here means the column does not exist, which is an answer.
        console.log(`  ${column.padEnd(20)} no such column`);
        continue;
      }
      const body = (await response.json()) as { n?: string }[];
      const n = Number(body[0]?.n ?? 0);
      if (n > 0) anyGeography = true;
      console.log(`  ${column.padEnd(20)} ${n.toLocaleString('en-GB')} rows with a value`);
    } catch (error) {
      console.log(
        `  ${column.padEnd(20)} could not check: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
  console.log(
    anyGeography
      ? '\n  Some rows DO carry coordinates. The 50-row sample above did not show them\n' +
          '  because Socrata omits null fields per row. A full ingestion will report the\n' +
          '  real geolocated percentage.'
      : '\n  No row in the dataset carries a coordinate under any known column name.',
  );

  /* -- Rows that actually carry coordinates --------------------------------- */

  // The decisive check. A census says coordinates exist somewhere in the
  // dataset; it does not say the adapter can read them. These are rows selected
  // *because* they have a position, normalised through the real adapter.
  let geoSample: unknown[] = [];
  let geoAccepted = 0;
  let geoGeolocated = 0;
  if (anyGeography) {
    console.log('\nROWS THAT CARRY COORDINATES');
    console.log('─'.repeat(100));
    const geoUrl = new URL(datasetUrl);
    geoUrl.searchParams.set('$limit', '25');
    geoUrl.searchParams.set('$where', 'latitude IS NOT NULL');
    try {
      const response = await fetch(geoUrl.toString(), {
        headers: {
          accept: 'application/json',
          ...(process.env.CAMDEN_APP_TOKEN ? { 'X-App-Token': process.env.CAMDEN_APP_TOKEN } : {}),
        },
      });
      geoSample = response.ok ? ((await response.json()) as unknown[]) : [];
    } catch {
      geoSample = [];
    }

    if (geoSample.length === 0) {
      console.log('  Could not fetch a sample of coordinate-bearing rows.');
    } else {
      const first = geoSample[0] as Record<string, unknown>;
      const extraColumns = Object.keys(first).filter((k) => !names.has(k)).sort();
      console.log(
        `  Columns these rows have that the first sample did not: ${
          extraColumns.length > 0 ? extraColumns.join(', ') : '(none)'
        }`,
      );
      for (const key of ['latitude', 'longitude', 'location', 'spatial_accuracy']) {
        if (key in first) {
          console.log(`  ${key.padEnd(18)} ${safeSample(key, first[key])}`);
        }
      }

      for (const [i, row] of geoSample.entries()) {
        const result = normaliseCamdenRow(row, i);
        if (!result.ok) continue;
        geoAccepted += 1;
        if (result.event.longitude !== null) geoGeolocated += 1;
      }
      console.log('');
      console.log(`  accepted        ${geoAccepted}/${geoSample.length}`);
      console.log(`  geolocated      ${geoGeolocated}/${geoAccepted}`);
      if (geoAccepted > 0 && geoGeolocated === 0) {
        console.log('  ✗ These rows have coordinates and the adapter read none of them.');
        console.log('    That is an adapter bug, not a property of the source.');
      }
    }
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
  } else if (anyGeography && geoAccepted > 0 && geoGeolocated === 0) {
    // The verdict must follow the census, not the first sample. Saying "this
    // dataset publishes no coordinates" while a count query above reports
    // hundreds of thousands of rows with them is worse than saying nothing.
    console.log('  ✗ The dataset carries coordinates on some rows and the adapter read none of');
    console.log('    them. That is an adapter bug. Fix it before ingesting.');
  } else if (anyGeography) {
    console.log('  ✓ The adapter reads this dataset, and it carries coordinates on some rows.');
    console.log(`    ${Math.round(acceptRate * 100)}% of the first sample normalised. That sample`);
    console.log('    happens to have no coordinates, which is why its geolocated count is 0 —');
    console.log(`    rows selected for having them geolocate ${geoGeolocated}/${geoAccepted}.`);
    console.log('    Only a full ingestion gives the real geolocated percentage.');
    console.log('\n    Next: npm run ingest:camden -- --dry-run --limit 5000');
  } else if (geolocated === 0) {
    const publishesCoordinates =
      names.has('longitude') || names.has('latitude') || pointColumn !== undefined;
    if (publishesCoordinates) {
      console.log('  ! Rows normalise, but no coordinate could be read from the columns that exist.');
      console.log('    That is an adapter or format problem — fix it before ingesting.');
    } else {
      console.log('  ! Rows normalise, and no row in the whole dataset carries a coordinate.');
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

/**
 * Distinct (ticket_type, ticket_description) combinations.
 *
 * The description is what resolves an unrecognised code: a probe that shows the
 * type alone leaves the only question worth asking unanswered.
 */
function countDistinctPairs(
  rows: readonly unknown[],
  typeColumn: string,
  descriptionColumn: string,
): Map<string, { type: string; description: string | null; count: number }> {
  const out = new Map<string, { type: string; description: string | null; count: number }>();
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    const rawType = record[typeColumn];
    if (rawType === null || rawType === undefined || String(rawType).trim() === '') continue;
    const type = String(rawType).trim();
    const rawDescription = record[descriptionColumn];
    const description =
      rawDescription === null || rawDescription === undefined || String(rawDescription).trim() === ''
        ? null
        : String(rawDescription).trim();
    const key = `${type}\u0000${description ?? ''}`;
    const existing = out.get(key);
    if (existing) existing.count += 1;
    else out.set(key, { type, description, count: 1 });
  }
  return out;
}

function sortedPairs(
  pairs: Map<string, { type: string; description: string | null; count: number }>,
): [string, { type: string; description: string | null; count: number }][] {
  return [...pairs.entries()].sort((a, b) => b[1].count - a[1].count || a[1].type.localeCompare(b[1].type));
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
  // Location columns keep their postcode districts, road numbers and junction
  // references: those are the tokens a street-reference lookup matches on, and
  // a probe that hides them hides the evidence it exists to gather.
  return redactRegistrations(String(value), redactionContextFor(name)).slice(0, 40);
}

main().catch((error) => {
  console.error('\n✗ Probe failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
