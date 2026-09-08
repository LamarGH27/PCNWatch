/**
 * The reviewer's worklist.
 *
 *   npx tsx scripts/review-bundle.ts            # everything still to decide
 *   npx tsx scripts/review-bundle.ts --all      # including decided ones
 *   npx tsx scripts/review-bundle.ts --usable   # what PCNWatch may actually say
 *
 * Deliberately a script and not an admin page. The decision it supports is made
 * once per proposition by somebody qualified, and building a web application
 * around that would be more surface than the task has: the review is a person
 * reading a statutory instrument with the candidate beside them, and what they
 * need is the document, the provision, and the question.
 *
 * Recording a decision is a code change — an edit to the candidate's `review`
 * block, in a commit, with the reviewer named. That is a feature. It goes
 * through the same review as any other change, it is attributable, and it
 * cannot be done by anything that can write to the database.
 */

import {
  allCandidates,
  bundleProgress,
  isApproved,
} from '../src/core/reference/candidates/store';
import { PROPOSITION_KIND_LABELS } from '../src/core/reference/candidates/types';

const args = new Set(process.argv.slice(2));
const showAll = args.has('--all');
const usableOnly = args.has('--usable');

const candidates = allCandidates().filter((candidate) => {
  if (usableOnly) return isApproved(candidate);
  if (showAll) return true;
  return candidate.review.decision === 'PENDING_LEGAL_REVIEW';
});

const progress = bundleProgress();

console.log('PCNWatch — legal reference review bundle\n');
console.log(`  ${progress.total} candidate propositions`);
for (const [decision, count] of Object.entries(progress.byDecision).sort()) {
  console.log(`    ${decision.padEnd(22)} ${count}`);
}
console.log(`    ${'source not yet opened'.padEnd(22)} ${progress.awaitingRetrieval}`);
console.log(`    ${'usable by PCNWatch'.padEnd(22)} ${progress.usable}`);

if (progress.usable === 0) {
  console.log(
    '\n  Nothing is approved, so PCNWatch states no legal proposition and the\n' +
      '  Defence Pack remains factual. That is the correct state until a\n' +
      '  qualified reviewer has worked through this list.',
  );
}

console.log(`\n${'='.repeat(78)}\n`);

for (const candidate of candidates) {
  console.log(`${candidate.id}   [${PROPOSITION_KIND_LABELS[candidate.kind]}]`);
  console.log(`  decision   ${candidate.review.decision}${candidate.review.reviewer ? ` by ${candidate.review.reviewer}` : ''}`);
  console.log(`\n  PROPOSITION`);
  console.log(wrap(candidate.proposition, 4));
  console.log(`\n  SOURCE TO OPEN`);
  console.log(`    ${candidate.source.organisation} — ${candidate.source.documentTitle}`);
  console.log(`    ${candidate.source.canonicalUrl}`);
  if (candidate.source.provision) console.log(`    provision: ${candidate.source.provision}`);
  console.log(`    tier: ${candidate.source.tier}`);
  console.log(
    `    retrieved: ${candidate.source.retrieval === 'RETRIEVED' ? candidate.source.retrievedAt : 'NOT YET — nobody has opened this'}`,
  );
  console.log(`\n  QUESTION FOR YOU`);
  console.log(wrap(candidate.reviewQuestion, 4));
  console.log(`\n  MUST NOT BE READ AS ESTABLISHING`);
  for (const line of candidate.doesNotEstablish) console.log(wrap(`- ${line}`, 4));
  console.log(`\n  APPLIES TO`);
  console.log(`    codes:      ${candidate.applicability.contraventionCodes?.join(', ') ?? 'any'}`);
  console.log(`    authority:  ${candidate.applicability.authoritySlug ?? 'any'}`);
  console.log(`    stages:     ${candidate.applicability.proceduralStages?.join(', ') ?? 'any'}`);
  for (const condition of candidate.applicability.conditions) console.log(wrap(`    ${condition}`, 0));
  console.log(`\n  TO APPROVE: set review to { decision: 'REVIEWED', reviewer: '<your name>',`);
  console.log(`              decidedAt: '<ISO date>' } AND fill in source.excerpt and`);
  console.log(`              source.retrievedAt. PCNWatch refuses an approval without both.`);
  console.log(`\n${'-'.repeat(78)}\n`);
}

function wrap(text: string, indent: number): string {
  const pad = ' '.repeat(indent);
  const words = text.split(' ');
  const lines: string[] = [];
  let line = pad;
  for (const word of words) {
    if (line.length + word.length + 1 > 78) {
      lines.push(line);
      line = pad;
    }
    line += (line.trim() === '' ? '' : ' ') + word;
  }
  lines.push(line);
  return lines.join('\n');
}
