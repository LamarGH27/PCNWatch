/**
 * One real extraction, against a notice nobody owns.
 *
 *   npm run scanner:smoke
 *
 * The first time a document reader meets a live model is the moment to find out
 * whether it works — and the wrong moment to be holding a customer's notice.
 * Everything read here is fictional: an authority that does not exist, a
 * registration issued to no vehicle, a PCN number belonging to nothing.
 *
 * Renders the synthetic notice to a PNG, sends it through the real extraction
 * path, and reports what came back. No database, no storage, no case record —
 * this proves the reader, nothing else.
 *
 * Prints no personal data because there is none to print. It does print the
 * extracted values, which is the entire point, and they are all invented.
 */

import './load-env';
import { extractNotice } from '../src/server/cases/extraction';
import { isConfigured, serverEnv } from '../src/lib/env';
import { SYNTHETIC_PCN, SYNTHETIC_PCN_TEXT, SYNTHETIC_MARKER } from '../tests/fixtures/pcn/synthetic-pcn';

/**
 * Renders the notice text to a PNG the vision path can read.
 *
 * A bitmap rather than a PDF: a photograph is what a user actually uploads, and
 * a reader proven only on machine-generated text has not been proven on the job
 * it does.
 */
async function renderNotice(): Promise<string> {
  // Rendered with the Chromium the repository already uses for its end-to-end
  // tests, rather than adding a native image dependency for one script. It also
  // produces something closer to a real notice than text on a blank canvas.
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    await page.setContent(`
      <style>
        body { font-family: Georgia, serif; margin: 0; background: #fff; color: #111; }
        .sheet { padding: 44px 52px; }
        .marker { background: #ffe8e8; border: 1px dashed #c00; color: #900;
                  padding: 8px 12px; font: 12px/1.4 monospace; margin-bottom: 24px; }
        h1 { font-size: 21px; letter-spacing: .06em; margin: 0 0 4px; }
        .sub { font-size: 12px; color: #444; margin-bottom: 22px; }
        h2 { font-size: 15px; margin: 26px 0 8px; border-bottom: 1px solid #999;
             padding-bottom: 4px; }
        pre { font: 13px/1.75 monospace; white-space: pre-wrap; margin: 0; }
      </style>
      <div class="sheet">
        <div class="marker">${SYNTHETIC_MARKER}</div>
        <h1>PENALTY CHARGE NOTICE</h1>
        <div class="sub">Served by post under the Traffic Management Act 2004</div>
        <pre>${SYNTHETIC_PCN_TEXT.replace(/[&<>]/g, (c) =>
          ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] as string,
        )}</pre>
      </div>
    `);
    const png = await page.screenshot({ fullPage: true });
    return png.toString('base64');
  } finally {
    await browser.close();
  }
}

function comparison(label: string, expected: unknown, actual: unknown): string {
  const match = String(expected) === String(actual);
  return `  ${match ? '✓' : '✗'} ${label.padEnd(34)} ${String(actual ?? '(none)').padEnd(46)}${
    match ? '' : `expected ${String(expected)}`
  }`;
}

async function main(): Promise<void> {
  if (!isConfigured('anthropic')) {
    console.error(
      '\n✗ ANTHROPIC_API_KEY is not configured in this process.\n' +
        '  Set it and re-run. Nothing else here is meaningful without it.\n',
    );
    process.exit(2);
  }

  const useText = process.argv.includes('--text');
  console.log(`\nSYNTHETIC PCN EXTRACTION  (model: ${serverEnv().ANTHROPIC_MODEL})`);
  console.log('─'.repeat(96));
  console.log(`  ${SYNTHETIC_MARKER}`);
  console.log(`  input: ${useText ? 'text' : 'rendered PNG'}\n`);

  const startedAt = Date.now();
  const outcome = useText
    ? await extractNotice({
        data: Buffer.from(SYNTHETIC_PCN_TEXT).toString('base64'),
        mediaType: 'image/png',
        extractedText: SYNTHETIC_PCN_TEXT,
      })
    : await extractNotice({
        data: await renderNotice(),
        mediaType: 'image/png',
        extractedText: SYNTHETIC_PCN_TEXT,
      });
  const latencyMs = Date.now() - startedAt;

  console.log(`  latency: ${(latencyMs / 1000).toFixed(1)}s\n`);

  if (outcome.kind === 'OUT_OF_SCOPE') {
    console.error(`✗ The notice was classified out of scope: ${outcome.message}`);
    console.error(`  ${outcome.explanation}\n`);
    process.exit(1);
  }

  if (outcome.kind === 'FAILED') {
    console.error(`✗ Extraction failed: ${outcome.what}`);
    console.error(`  ${outcome.whatYouCanDo}\n`);
    process.exit(1);
  }

  console.log('EXTRACTED FIELDS');
  console.log('─'.repeat(96));
  const byKey = new Map(outcome.fields.map((f) => [f.key, f]));
  const expectations: [string, string, unknown][] = [
    ['authorityName', 'Issuing authority', SYNTHETIC_PCN.authorityName],
    ['pcnNumber', 'PCN number', SYNTHETIC_PCN.pcnNumber],
    ['vehicleRegistration', 'Vehicle registration', SYNTHETIC_PCN.vehicleRegistration],
    ['contraventionCode', 'Contravention code', SYNTHETIC_PCN.contraventionCode],
    ['incidentDate', 'Contravention date', SYNTHETIC_PCN.incidentDate],
    ['incidentTime', 'Contravention time', SYNTHETIC_PCN.incidentTime],
    ['issueDate', 'Issue date', SYNTHETIC_PCN.issueDate],
    ['fullAmountPence', 'Full amount (pence)', SYNTHETIC_PCN.fullAmountPence],
    ['discountedAmountPence', 'Discounted amount (pence)', SYNTHETIC_PCN.discountedAmountPence],
    ['discountDeadlinePrinted', 'Discount deadline (printed)', SYNTHETIC_PCN.discountDeadlinePrinted],
    [
      'representationDeadlinePrinted',
      'Representation deadline (printed)',
      SYNTHETIC_PCN.representationDeadlinePrinted,
    ],
  ];

  let correct = 0;
  for (const [key, label, expected] of expectations) {
    const field = byKey.get(key);
    if (String(field?.value) === String(expected)) correct += 1;
    console.log(comparison(label, expected, field?.value));
  }

  console.log('\nCONFIDENCE AND VERIFICATION');
  console.log('─'.repeat(96));
  for (const field of outcome.fields) {
    console.log(
      `  ${field.label.padEnd(38)} ${field.confidence.toFixed(2)}  ${
        field.requiresVerification ? 'must be confirmed by the user' : 'shown for confirmation'
      }`,
    );
  }

  console.log('\nRESULT');
  console.log('─'.repeat(96));
  console.log(`  Notice type            ${outcome.noticeType}`);
  console.log(`  Legibility             ${outcome.legibility}`);
  console.log(`  Schema validation      ACCEPTED (a rejected response never reaches here)`);
  console.log(`  Fields matching        ${correct} of ${expectations.length}`);
  console.log(`  Requiring confirmation ${outcome.fields.filter((f) => f.requiresVerification).length} of ${outcome.fields.length}`);
  if (outcome.unreadableRegions.length > 0) {
    console.log(`  Reported unreadable    ${outcome.unreadableRegions.join('; ')}`);
  }

  // An invented value is worse than a missing one, so it is called out
  // separately from a simple miss.
  const invented = expectations.filter(([key, , expected]) => {
    const actual = byKey.get(key)?.value;
    return actual !== null && actual !== undefined && String(actual) !== String(expected);
  });
  if (invented.length > 0) {
    console.log('\n  ⚠  Values that differ from the notice (not omissions — different values):');
    for (const [, label, expected] of invented) console.log(`     ${label}: expected ${expected}`);
  }

  console.log(
    correct === expectations.length && invented.length === 0
      ? '\n✓ Every field read correctly. Nothing was invented.\n'
      : `\n✗ ${expectations.length - correct} field(s) did not match.\n`,
  );
  process.exit(correct === expectations.length ? 0 : 1);
}

main().catch((error) => {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
