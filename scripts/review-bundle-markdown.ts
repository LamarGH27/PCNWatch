/**
 * The reviewer's pack, as a document they can work through and hand back.
 *
 *   npx tsx scripts/review-bundle-markdown.ts            # writes the default path
 *   npx tsx scripts/review-bundle-markdown.ts <path>     # somewhere else
 *
 * Separate from `review-bundle.ts`, which prints a worklist to a terminal. This
 * writes a file with blank fields in it: an excerpt box, a comments box, a
 * decision and a signature line. A reviewer works on paper or in a document,
 * not in a scrollback buffer, and what comes back is the thing that gets typed
 * into the candidates.
 *
 * It is generated rather than written, so it cannot drift from the candidates.
 * A test asserts the committed file matches what this produces.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  INITIAL_LAUNCH_REVIEW,
  bundleProgress,
  forReview,
} from '../src/core/reference/candidates/store';
import {
  PROPOSITION_KIND_LABELS,
  TIER_MAY_ESTABLISH,
  type CandidateProposition,
} from '../src/core/reference/candidates/types';

const DEFAULT_PATH = 'docs/legal-review-bundle.md';

function list(values: readonly string[] | null, fallback = 'Any'): string {
  if (values === null) return fallback;
  if (values.length === 0) return 'None';
  return values.join(', ');
}

function candidateSection(candidate: CandidateProposition, index: number): string {
  const { source, applicability, review } = candidate;
  const lines: string[] = [];

  lines.push(`### ${index}. \`${candidate.id}\``);
  lines.push('');
  lines.push(`**Classification** \`${candidate.kind}\` — ${PROPOSITION_KIND_LABELS[candidate.kind]}`);
  lines.push('');

  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push(`| Organisation | ${source.organisation} |`);
  lines.push(`| Document | ${source.documentTitle} |`);
  lines.push(`| Canonical URL | <${source.canonicalUrl}> |`);
  lines.push(`| Provision | ${source.provision ?? '_whole document_'} |`);
  lines.push(`| Jurisdiction | ${source.jurisdiction} |`);
  lines.push(`| Source tier | \`${source.tier}\` — may establish: ${TIER_MAY_ESTABLISH[source.tier].join(', ')} |`);
  lines.push(`| Retrieval | \`${source.retrieval}\`${source.retrievedAt ? ` (${source.retrievedAt})` : ' — **nobody has opened this document**'} |`);
  lines.push('');

  lines.push('**Candidate proposition**');
  lines.push('');
  lines.push(`> ${candidate.proposition}`);
  lines.push('');

  lines.push('**Applicability**');
  lines.push('');
  lines.push(`- Contravention codes: ${list(applicability.contraventionCodes)}`);
  lines.push(`- Authority: ${applicability.authoritySlug ?? 'Any'}`);
  lines.push(`- Notice types: ${list(applicability.noticeTypes as readonly string[] | null)}`);
  lines.push(`- Procedural stages: ${list(applicability.proceduralStages as readonly string[] | null)}`);
  for (const condition of applicability.conditions) lines.push(`- ${condition}`);
  lines.push('');

  lines.push('**Must not be read as establishing**');
  lines.push('');
  for (const constraint of candidate.doesNotEstablish) lines.push(`- ${constraint}`);
  lines.push('');

  lines.push('**Question for the reviewer**');
  lines.push('');
  lines.push(`> ${candidate.reviewQuestion}`);
  lines.push('');

  lines.push('**Bounded excerpt from the source** _(paste the wording you actually read)_');
  lines.push('');
  lines.push('```');
  lines.push('');
  lines.push('```');
  lines.push('');

  lines.push('**Reviewer comments**');
  lines.push('');
  lines.push('```');
  lines.push('');
  lines.push('```');
  lines.push('');

  lines.push('**Decision** — delete as appropriate');
  lines.push('');
  lines.push('`PENDING_LEGAL_REVIEW` / `REVIEWED` / `NEEDS_CHANGE` / `REJECTED`');
  lines.push('');
  lines.push(`Currently recorded: \`${review.decision}\``);
  lines.push('');
  lines.push('| | |');
  lines.push('| --- | --- |');
  lines.push('| Reviewer name | |');
  lines.push('| Qualification | |');
  lines.push('| Date reviewed | |');
  lines.push('| Date source retrieved | |');
  lines.push('');
  lines.push('---');
  lines.push('');
  return lines.join('\n');
}

export function renderReviewBundle(): string {
  const progress = bundleProgress();
  const ordered = forReview();
  const launch = ordered.filter((c) => INITIAL_LAUNCH_REVIEW.includes(c.id));
  const rest = ordered.filter((c) => !INITIAL_LAUNCH_REVIEW.includes(c.id));

  const out: string[] = [];
  out.push('# PCNWatch — legal reference review pack');
  out.push('');
  out.push('<!--');
  out.push('  GENERATED FILE. Do not edit by hand.');
  out.push('    npx tsx scripts/review-bundle-markdown.ts');
  out.push('  It is generated from the candidate propositions so it cannot drift from');
  out.push('  them, and a test fails if the committed copy is stale.');
  out.push('-->');
  out.push('');
  out.push(
    'This is the document a qualified reviewer works through. Every proposition below is a',
    'candidate: something PCNWatch would like to be able to say, the document it would have to',
    'come from, and what it must not be read as establishing.',
  );
  out.push('');
  out.push('**Nothing here is approved.** Until a proposition is reviewed, PCNWatch states no');
  out.push('legal ground and the Defence Pack argues facts. That is the intended state.');
  out.push('');

  out.push('## Where the bundle stands');
  out.push('');
  out.push('| | |');
  out.push('| --- | --- |');
  out.push(`| Candidate propositions | ${progress.total} |`);
  for (const [decision, count] of Object.entries(progress.byDecision).sort()) {
    out.push(`| \`${decision}\` | ${count} |`);
  }
  out.push(`| Source not yet opened | ${progress.awaitingRetrieval} |`);
  out.push(`| **Usable by PCNWatch** | **${progress.usable}** |`);
  out.push('');

  out.push('## Before you start');
  out.push('');
  out.push(
    'No source in this pack has been opened. The environment the candidates were prepared in',
    'could not reach legislation.gov.uk, londoncouncils.gov.uk, westminster.gov.uk or',
    'londontribunals.gov.uk, so **every excerpt is blank and no source text has been read**.',
  );
  out.push('');
  out.push('That is deliberate. An invented excerpt is the single most dangerous artefact this');
  out.push('project could produce, because it would look exactly like evidence that somebody');
  out.push('checked. The candidates name the document and provision precisely enough for you to');
  out.push('open them, and stop there.');
  out.push('');
  out.push('A proposition becomes usable only when **all** of these hold:');
  out.push('');
  out.push('1. You recorded `decision: REVIEWED`.');
  out.push('2. You are **named**. `reviewer: null` is not an approval.');
  out.push('3. The source was opened — `retrieval: RETRIEVED` with a date.');
  out.push('4. An `excerpt` was recorded from the source.');
  out.push('5. Nothing supersedes it.');
  out.push('6. The source **tier** is competent to establish that **kind** of proposition.');
  out.push('');
  out.push('Conditions 3 and 4 exist because condition 1 is a field a script could set.');
  out.push('');

  out.push('## Initial Launch Review');
  out.push('');
  out.push(
    `The ${launch.length} propositions on the critical path to a Defence Pack for the launch`,
    'scenario: a London local-authority parking PCN, contravention code 12, paid through a',
    'parking app, registration possibly entered incorrectly, issued by Westminster.',
  );
  out.push('');
  launch.forEach((candidate, i) => out.push(candidateSection(candidate, i + 1)));

  out.push('## Also awaiting review');
  out.push('');
  out.push(
    `${rest.length} further candidates. Real, and still undecided, but not on the critical path`,
    'for the launch scenario — they can be taken in a later sitting.',
  );
  out.push('');
  rest.forEach((candidate, i) => out.push(candidateSection(candidate, launch.length + i + 1)));

  out.push('## Returning your decisions');
  out.push('');
  out.push('Recording a decision is a code change: an edit to the candidate\'s `review` block and');
  out.push('its `source` provenance in `src/core/reference/candidates/`, in a commit, with you');
  out.push('named. That is a feature — it goes through the same review as any other change, it is');
  out.push('attributable, and it cannot be done by anything that can write to the database.');
  out.push('');
  out.push('Approving a deadline rule here does **not** release a calculated date to users. The');
  out.push('deadline projection gates on its own rule store, which needs its own review.');
  out.push('');
  return `${out.join('\n')}\n`;
}

if (process.argv[1] && process.argv[1].endsWith('review-bundle-markdown.ts')) {
  const target = resolve(process.argv[2] ?? DEFAULT_PATH);
  writeFileSync(target, renderReviewBundle(), 'utf8');
  console.log(`Wrote ${target}`);
}
