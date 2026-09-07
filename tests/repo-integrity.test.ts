import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/**
 * The repository must contain the code it is built from.
 *
 * This exists because it did not. `.gitignore` carried an unanchored
 * `coverage/`, which matches a directory of that name at any depth, so
 * `src/core/coverage/` was never tracked. The file sat in a working tree, every
 * local build and test run passed against it, and a fresh checkout failed to
 * compile — the one place nobody was looking.
 *
 * Nothing about that was detectable by running tests, because the tests ran
 * against the same working tree. So this asserts the property directly: no
 * source file may be ignored or untracked. It runs with the rest of the suite,
 * which is the only reason it will actually be run.
 */

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE_DIRS = ['src', 'scripts', 'tests', 'supabase', 'docs'];

function git(args: readonly string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * `git grep`, where finding nothing is an answer rather than a failure.
 *
 * git exits 1 when a pattern does not match, which is exactly the outcome these
 * guards are hoping for — so an unguarded call fails the test it was meant to
 * pass.
 */
/**
 * Source with its comments removed.
 *
 * Guards that read code should read the code. Several of these explain, in a
 * comment beside the assertion, exactly the construct they are asserting is
 * absent — and a guard that its own explanation can fail is a guard somebody
 * silences by deleting the explanation.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
}

function gitGrepLines(pattern: string, path: string): string[] {
  try {
    return git(['grep', '-n', pattern, '--', path])
      .trim()
      .split('\n')
      .filter((line) => line !== '');
  } catch (error) {
    // Exit 1 means no matches. Anything else is a real failure worth surfacing.
    if ((error as { status?: number }).status === 1) return [];
    throw error;
  }
}

const gitAvailable = (() => {
  try {
    git(['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(gitAvailable)('the repository contains what it is built from', () => {
  it('ignores no file under a source directory', () => {
    // `check-ignore` exits 1 when nothing matches, which is the passing case.
    let ignored = '';
    try {
      ignored = git(['check-ignore', '--', ...SOURCE_DIRS]);
    } catch {
      ignored = '';
    }
    expect(ignored.trim(), 'these source paths are gitignored and will be missing from a checkout')
      .toBe('');
  });

  it('leaves no source file untracked', () => {
    const untracked = git([
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      ...SOURCE_DIRS,
    ]).trim();
    // An untracked file is invisible in exactly the same way an ignored one is.
    expect(untracked, 'these source files are not committed').toBe('');
  });

  it('keeps build-artefact ignores anchored to the repository root', () => {
    // The root cause, asserted directly: an unanchored directory pattern matches
    // at every depth, so `coverage/` silently swallowed `src/core/coverage/`.
    // The working tree, not HEAD: catching a regression before it is committed
    // is the whole point, and HEAD is by definition already too late.
    const lines = readFileSync(resolve(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));

    for (const pattern of ['coverage/', 'out/', 'build/', 'dist/']) {
      expect(lines, `"${pattern}" must be anchored as "/${pattern}"`).not.toContain(pattern);
    }
  });
});

/**
 * What the user says and what PCNWatch holds must stay apart.
 *
 * This is one line of code away from being wrong at any time. The moment a
 * declaration of "I have a permit" is written into `evidenceProvided`, the
 * evidence basis starts rising on documents nobody has seen, and a user submits
 * a challenge believing it is evidenced when it rests on their own say-so. The
 * behaviour is covered by tests; this guards the shape, because the tempting
 * edit is a one-liner in exactly one place.
 */
describe('declared evidence is never counted as held evidence', () => {
  const ASSESS = resolve(ROOT, 'src/server/cases/assess-verified.ts');

  it('passes an empty evidenceProvided to the engine', () => {
    const source = readFileSync(ASSESS, 'utf8');
    const start = source.indexOf('assessCase({');
    expect(start, 'assessCase call not found').toBeGreaterThan(-1);
    const call = source.slice(start, source.indexOf('});', start));

    expect(call, 'assessCase is no longer given the fields this guard reads').toContain(
      'assertedGroundKeys',
    );
    // Nothing is uploaded in this flow, so the only correct value is empty.
    expect(call).toMatch(/evidenceProvided:\s*\{\}/);
    // And in particular, not derived from what the user declared.
    expect(call).not.toMatch(/evidenceProvided:[^,]*declaredEvidence/);
  });

  it('never asserts a statutory ground from an answer', () => {
    const source = readFileSync(ASSESS, 'utf8');
    const start = source.indexOf('assessCase({');
    const call = source.slice(start, source.indexOf('});', start));

    // A ground is something the user chooses to rely on, not something an
    // answer of "yes" produces on their behalf.
    expect(call).toMatch(/assertedGroundKeys:\s*\[\]/);
  });

  it('keeps the narrative out of the case request schema', () => {
    // The account reaches exactly one endpoint. A `narrative` string field on
    // the shared case schema would be a second door into the rest of the
    // system — and now into the database as well.
    const route = readFileSync(resolve(ROOT, 'src/app/api/cases/schema.ts'), 'utf8');
    expect(route).not.toMatch(/narrative:\s*z\.string/);
    expect(route).toContain('narrativeProvided: z.boolean()');
  });

  it('accepts only confirmed assertions, in a shape an unconfirmed one cannot take', () => {
    const route = readFileSync(resolve(ROOT, 'src/app/api/cases/schema.ts'), 'utf8');
    const start = route.indexOf('confirmedAssertions:');
    expect(start, 'confirmedAssertions is no longer on the schema').toBeGreaterThan(-1);
    const block = route.slice(start, route.indexOf('.max(20)', start));

    // A kind and a stance, both closed. Nothing else — a summary or a
    // confidence here would mean the model's own words travelling to the
    // engine, and a `confirmed` flag would mean unconfirmed ones travelling
    // alongside them, relying on something downstream to filter them out.
    expect(block).toContain('z.enum(NARRATIVE_ASSERTION_KINDS)');
    expect(block).toContain('z.enum(NARRATIVE_STANCES)');
    expect(block).not.toMatch(/summary/);
    expect(block).not.toMatch(/confidence/);
    expect(block).not.toMatch(/confirmed:\s*z\./);
  });
});

/**
 * What happens to something a user wrote about their own life.
 *
 * Every rule here is one line of code from being wrong, and none of them fails
 * loudly when it breaks — a narrative in a log or an audit row looks exactly
 * like a working feature. The behaviour is covered by tests; this guards the
 * shape, at the two places the shape is decided.
 */
/**
 * The verification screen has to mean what it appears to mean.
 *
 * `collectVerifiedFacts` sends only ticked fields, and the submit button only
 * ever demands ticks on the five fields in ALWAYS_VERIFY. Everything else — the
 * issuing authority, the registration, the location, the printed deadlines —
 * is displayed with a value read off the notice and no request to check it. If
 * those start unticked they are silently discarded on submit, which is what
 * sent a real Westminster case to the saved-case page reading "Authority not
 * identified" after its owner had watched "Issuing authority: City of
 * Westminster" on the previous screen.
 *
 * The behaviour is covered by tests that rebuild the confirmation map
 * themselves; this pins the one line in the flow that builds it for real,
 * because that line is where the bug was and a test that constructs its own
 * input cannot notice it going away.
 */
describe('a field the user is not asked to check is accepted, not discarded', () => {
  it('seeds the confirmation map from requiresVerification', () => {
    const flow = readFileSync(resolve(ROOT, 'src/app/analyse/AnalyseFlow.tsx'), 'utf8');
    const start = flow.indexOf("if (result.kind === 'EXTRACTED')");
    expect(start, 'the extraction branch has moved').toBeGreaterThan(-1);
    const branch = flow.slice(start, flow.indexOf('setStep({ kind: ', start));

    expect(branch, 'the flow no longer seeds confirmations from the extraction').toMatch(
      /setConfirmed\(\s*Object\.fromEntries\(/,
    );
    expect(branch).toMatch(/!f\.requiresVerification/);
    // The empty seed is the bug: it throws away every field the screen did not
    // demand a tick for.
    expect(branch, 'confirmations are seeded empty again').not.toMatch(/setConfirmed\(\{\}\)/);
  });

  it('keeps the fields that must be checked out of the seed', () => {
    // A seed that accepted everything would be worse than the bug: the user
    // would never be asked to check the PCN number or the dates.
    const extraction = readFileSync(resolve(ROOT, 'src/server/cases/extraction.ts'), 'utf8');
    const start = extraction.indexOf('export const ALWAYS_VERIFY');
    const list = extraction.slice(start, extraction.indexOf('];', start));
    for (const field of ['pcnNumber', 'contraventionCode', 'incidentDate', 'issueDate', 'fullAmountPence']) {
      expect(list, `${field} no longer always requires a tick`).toContain(field);
    }
  });
});

describe('a written account is not kept anywhere', () => {
  const CLIENT = resolve(ROOT, 'src/server/ai/client.ts');

  it('marks narrative extraction as a private-input job', () => {
    const source = readFileSync(CLIENT, 'utf8');
    const start = source.indexOf('const PRIVATE_INPUT_JOBS');
    expect(start, 'the private-input policy is gone').toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf(';', start))).toContain('NARRATIVE_EXTRACTION');
  });

  it('does not persist the output of a job whose output must not be logged', () => {
    const source = readFileSync(CLIENT, 'utf8');
    // The summaries are drawn from the account and can restate it nearly word
    // for word, so storing them stores the account under another name.
    expect(source).toMatch(/output:\s*outputNotLogged\s*\?\s*null\s*:\s*raw/);
  });

  it('never writes evidence readings or narrative output to the audit trail', () => {
    /*
     * `ai_logs` is a service-role table, outside every user's RLS scope and
     * beyond their reach to delete. Narrative output restates what someone
     * wrote about their life; evidence readings are the registrations, permit
     * numbers and badge serials transcribed off their documents. Both already
     * live somewhere the user owns, so a second copy here would be keeping
     * their private information for our convenience alone.
     */
    const source = readFileSync(CLIENT, 'utf8');
    const start = source.indexOf('const OUTPUT_NOT_LOGGED');
    expect(start, 'the output-logging policy is gone').toBeGreaterThan(-1);
    const list = source.slice(start, source.indexOf(';', start));
    for (const job of ['NARRATIVE_EXTRACTION', 'EVIDENCE_ANALYSIS']) {
      expect(list, `${job} output would now be written to ai_logs`).toContain(job);
    }
  });

  it('does not fingerprint a private-input job by its content', () => {
    const source = readFileSync(CLIENT, 'utf8');
    expect(source).toMatch(/hashText:\s*!isPrivateInput/);
  });

  it('is removed by a migration of its own, not by the one that adds things', () => {
    /*
     * Expand → deploy → contract, enforced as a shape.
     *
     * The first version of this work dropped `user_narrative` in the same
     * migration that added the new columns. That would have run against the
     * database Production was already using, and the deployed build still names
     * that column in `getCase` — so the drop would have broken every case page
     * until a deploy caught up. The removal belongs in a file that runs after
     * the deploy, and this checks it is in one.
     */
    const dir = resolve(ROOT, 'supabase/migrations');
    const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const sqlOf = (file: string) => readFileSync(resolve(dir, file), 'utf8');

    const droppers = migrations.filter((f) => /drop column[^;]*user_narrative/i.test(sqlOf(f)));
    expect(droppers, 'no migration removes the narrative column').toHaveLength(1);

    const [dropper] = droppers;
    // The contract migration does one thing. A file that also adds columns is a
    // file somebody will feel safe running early.
    expect(sqlOf(dropper as string)).not.toMatch(/add column/i);
    expect(dropper).toMatch(/^0015_/);

    // And it says, in the file, that it must not be run before the deploy.
    expect(sqlOf(dropper as string)).toMatch(/until production is running code that does not name it/i);
  });

  it('adds the replacement before the removal, so the order is deployable', () => {
    const dir = resolve(ROOT, 'supabase/migrations');
    const migrations = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const sqlOf = (file: string) => readFileSync(resolve(dir, file), 'utf8');

    const addsReplacement = migrations.findIndex((f) =>
      /add column if not exists narrative_provided/i.test(sqlOf(f)),
    );
    const dropsLegacy = migrations.findIndex((f) =>
      /drop column[^;]*user_narrative/i.test(sqlOf(f)),
    );

    expect(addsReplacement, 'nothing adds narrative_provided').toBeGreaterThan(-1);
    expect(dropsLegacy, 'nothing drops user_narrative').toBeGreaterThan(-1);
    expect(
      addsReplacement,
      'the column is dropped before its replacement exists',
    ).toBeLessThan(dropsLegacy);
  });

  it('keeps the expand migration free of anything the old build could notice', () => {
    const expand = readFileSync(
      resolve(ROOT, 'supabase/migrations/0014_case_context_and_anonymous_owners.sql'),
      'utf8',
    );
    for (const destructive of [/drop\s+column/i, /rename\s+column/i, /drop\s+table/i, /drop\s+constraint\s+(?!if\s+exists)/i]) {
      expect(expand, `0014 contains ${destructive}`).not.toMatch(destructive);
    }
  });

  it('is queried by no application code', () => {
    /*
     * The invariant that actually protects the user, and the one that makes
     * 0015 safe to run at all: nothing in the product reads or writes the
     * column, whether or not it still exists.
     *
     * Checked across all of src/ rather than at the two files that used to name
     * it, because the point is that there is no path — a reader added tomorrow
     * is caught here rather than by a failed migration.
     *
     * A comment may mention it. Explaining why a column is not used is how the
     * next person avoids reintroducing it, so only occurrences in code count.
     */
    const hits = gitGrepLines('user_narrative', 'src/')
      .filter((line) => {
        const code = line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1).trim();
        return !code.startsWith('*') && !code.startsWith('//') && !code.startsWith('--');
      });

    expect(hits, `application code still queries the narrative column:\n${hits.join('\n')}`).toEqual(
      [],
    );
  });

  it('no longer carries the narrative on the case record', () => {
    // `CaseRecord.userNarrative` was the field the column was read into. It is
    // gone; `narrativeProvided` replaced it. `userNarrativeProvided` — the
    // engine's own boolean input — is a different thing and stays.
    const hits = gitGrepLines('userNarrative[^P]', 'src/');
    expect(hits, `the narrative field is still on the case record:\n${hits.join('\n')}`).toEqual([]);
  });

  it('never writes an owner it was given', () => {
    // `user_id` defaults to auth.uid() and RLS checks the same value, so the
    // database decides the owner. A user_id in the write path would be a value
    // that could be wrong.
    const persist = readFileSync(resolve(ROOT, 'src/server/cases/persist.ts'), 'utf8');
    const start = persist.indexOf('export function toCaseRow');
    const row = persist.slice(start, persist.indexOf('\n}', start));
    expect(row).not.toMatch(/user_id/);
  });

  it('reads accounts from exactly one endpoint', () => {
    // Grepped rather than assumed: a second caller of readNarrative would be a
    // second place these rules have to hold, and it would not announce itself.
    const callers = execFileSync(
      'git',
      ['grep', '-l', 'readNarrative', '--', 'src/'],
      { cwd: ROOT, encoding: 'utf8' },
    )
      .trim()
      .split('\n')
      .filter((f) => f !== 'src/server/cases/read-narrative.ts');

    expect(callers).toEqual(['src/app/api/cases/narrative/route.ts']);
  });
});

/**
 * `next build` must not need a database.
 *
 * A prerendered route that reads live data freezes whatever the database said at
 * build time. A build run while the database was unreachable baked "data
 * temporarily unavailable" into /map and an empty location list into the
 * sitemap, and served both — a transient build-time blip turned into a
 * user-visible falsehood, and a static sitemap has nothing to revalidate it.
 *
 * A route is safe if it opts out of prerendering explicitly, or reads
 * `searchParams`, which makes it dynamic anyway.
 */
/**
 * The lifecycle is only as good as the wiring around it.
 *
 * `supportsAssessment` is covered by tests that call it directly, and those
 * tests would keep passing if the case view stopped consulting it — one line
 * changed from `counts.supporting` to `counts.held` and every upload starts
 * closing gaps, with the whole lifecycle still passing its own suite.
 *
 * The behaviour is covered through `buildCaseView` in evidence-basis.test.ts.
 * This pins the shape at the two places the decision is actually made, because
 * they are the places the mistake would be silent.
 */
describe('an upload is not evidence until somebody has checked it', () => {
  const CASE_VIEW = resolve(ROOT, 'src/server/cases/case-view.ts');

  it('gives the checklist and the engine the supporting count, not the held one', () => {
    const source = readFileSync(CASE_VIEW, 'utf8');
    expect(source, 'the two counts are no longer computed').toContain('countEvidence(');

    // The checklist decides what counts as a met requirement, and the engine
    // decides the evidence basis. Both must see only confirmed evidence.
    expect(source).toMatch(/provided:\s*counts\.supporting/);
    expect(source).toMatch(/evidenceProvided:\s*counts\.supporting/);
    expect(source, 'held files are being counted as support').not.toMatch(
      /(provided|evidenceProvided):\s*counts\.held/,
    );
    // `held` may reach the checklist for display, and nowhere else.
    expect(source).toMatch(/held:\s*counts\.held/);
  });

  it('compares only evidence that supports the case', () => {
    const source = readFileSync(CASE_VIEW, 'utf8');
    // A comparison drawn from an unconfirmed reading would put a model's guess
    // about somebody's registration beside their notice as though they had
    // agreed it was right.
    expect(source).toMatch(/filter\(supportsAssessment\)/);
  });
});

/**
 * Evidence is private, and the checks that keep it private are structural.
 *
 * None of these fails loudly when it breaks. A service-role client reading
 * evidence looks exactly like a working feature, right up to the day it returns
 * somebody else's photographs.
 */
describe('evidence stays private', () => {
  const STORE = resolve(ROOT, 'src/server/evidence/store.ts');

  it('never touches evidence with the service role', () => {
    const source = readFileSync(STORE, 'utf8');
    /*
     * RLS is the only thing standing between one user's documents and another,
     * and the service role bypasses it entirely. Every query here runs through
     * the caller's own session, so a missing ownership check fails closed
     * rather than open — which is why there are no ownership checks in that
     * file, and why this one line matters more than any of them would.
     */
    expect(source).not.toContain('createSupabaseServiceClient');
    expect(source).toContain('createSupabaseServerClient');
  });

  it('refuses uploads until storage is actually safe', () => {
    const source = readFileSync(STORE, 'utf8');
    // Migration 0006 cannot create the storage.objects policies on hosted
    // Supabase, so "the migration ran" says nothing about whether one user's
    // photographs are readable by another.
    const start = source.indexOf('export async function uploadEvidence');
    expect(start, 'uploadEvidence is gone').toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\nexport ', start + 1));
    expect(body).toContain('getStorageReadiness()');
    expect(body).toMatch(/STORAGE_NOT_READY/);
  });

  it('names the owner on every evidence insert', () => {
    /*
     * The shape mistake that broke the first real upload in Preview.
     *
     * `pcn_cases` takes its owner from a column default, so its save endpoint
     * correctly sends none — and this file was written in that shape without
     * `pcn_evidence` having the same default. RLS read `NULL = auth.uid()` as
     * NULL rather than true and refused every row with 42501.
     *
     * Migration 0017 adds the default too, so this is belt and braces rather
     * than the only thing holding it up. It is here because the failure was
     * invisible in every other kind of test: an insert that omits a column
     * looks exactly like one that does not need it.
     */
    const source = readFileSync(STORE, 'utf8');
    const start = source.indexOf("from('pcn_evidence')\n      .insert({");
    expect(start, 'the evidence insert is gone or reshaped').toBeGreaterThan(-1);
    const call = withoutComments(source.slice(start, source.indexOf('})', start)));

    expect(call, 'the insert no longer names the owner').toMatch(/user_id:\s*userId/);
    // From the verified session, never from the request.
    expect(call).not.toMatch(/user_id:\s*request\./);
  });

  it('never makes an evidence object public', () => {
    const offenders = gitGrepLines('getPublicUrl', 'src');
    expect(offenders, `a public object URL is being created:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('signs a URL only for the person who owns the file, and briefly', () => {
    const source = readFileSync(STORE, 'utf8');
    const start = source.indexOf('export async function signedEvidenceUrl');
    const body = source.slice(start, source.indexOf('\nexport ', start + 1));
    // Minted with the caller's own session, so it cannot outrun RLS.
    expect(body).toContain('session.value.supabase.storage');
    expect(body).toMatch(/createSignedUrl\(path, 300\)/);
  });

  it('confirms readings by position, never by value', () => {
    /*
     * If the verify endpoint accepted values, a client could post any text it
     * liked and have it recorded as something the user had confirmed reading
     * off their own document.
     */
    const route = readFileSync(
      resolve(ROOT, 'src/app/api/evidence/[evidenceId]/verify/route.ts'),
      'utf8',
    );
    const start = route.indexOf('const bodySchema');
    const schema = route.slice(start, route.indexOf('});', start));
    expect(schema).toContain('z.array(z.number()');
    expect(schema).not.toMatch(/z\.string\(\)/);
    expect(schema).not.toMatch(/value/);
  });

  it('never echoes what the model said about a file back to the user', () => {
    /*
     * A rejection can quote the response — including a reading rejected for
     * containing a conclusion. Putting that on the user's screen would show
     * them a fabricated sentence presented as what their own document said,
     * and writing it to the row would store it on their case.
     *
     * So the message and the stored reason are ours, written from the outcome.
     * The model's words stay in the rejection log, where a person looking for
     * a fabrication can find them.
     */
    const source = readFileSync(resolve(ROOT, 'src/server/evidence/analyse.ts'), 'utf8');
    const start = source.indexOf('if (!result.ok || !result.data)');
    expect(start, 'the failure branch is gone').toBeGreaterThan(-1);
    // Comments stripped first: this branch explains why it does not use
    // `result.errors`, and a guard that trips on its own reasoning is worse
    // than no guard — the next person deletes the comment to make it pass.
    const branch = withoutComments(source.slice(start, source.indexOf('\n  // Second line', start)));
    expect(branch).not.toMatch(/result\.errors/);
    expect(branch).toContain('reasonFor(result.outcome)');
  });

  it('keeps a failed reading from moving the case', () => {
    const source = readFileSync(resolve(ROOT, 'src/server/evidence/store.ts'), 'utf8');
    const start = source.indexOf('export async function recordAnalysisFailure');
    const body = source.slice(start, source.indexOf('\nexport ', start + 1));
    // The file is retained and the status is untouched: a failure is something
    // that happened to us, not to the user's evidence.
    expect(body).not.toMatch(/status:\s*'/);
    expect(body).not.toMatch(/storage_path/);
    expect(body).toContain('analysis_failure');
  });

  it('validates uploads on the server rather than trusting the browser', () => {
    const route = readFileSync(
      resolve(ROOT, 'src/app/api/cases/[id]/evidence/route.ts'),
      'utf8',
    );
    // The route hands the file to the server-side validator; the allowlist is
    // not re-stated here, so it cannot drift from the one the store enforces.
    expect(route).toContain('uploadEvidence(');
    expect(route).toMatch(/UNSUPPORTED_TYPE|result\.rejection\.reason/);
  });
});

/**
 * The Defence Pack's order of operations.
 *
 * Rules and evidence first, model last. Every test of the pack itself would
 * keep passing if the drafting layer quietly became the source — the pack would
 * still be built correctly, and the letter would simply stop being bound to it.
 * These pin the shape at the three places that decide it.
 */
describe('the Defence Pack is built before it is written', () => {
  const BUILD = resolve(ROOT, 'src/server/defence/build.ts');

  it('builds the pack without calling a model', () => {
    /*
     * The deterministic half is what the user is paying for. If a model ever
     * reaches this file, the sections stop being derived from the record and
     * start being proposed and checked, which is a different product with a
     * different safety story.
     */
    const source = withoutComments(readFileSync(BUILD, 'utf8'));
    expect(source).not.toMatch(/runAiJob|anthropic|@\/server\/ai\//i);
  });

  it('gives the drafting layer only what the pack established', () => {
    const source = withoutComments(readFileSync(resolve(ROOT, 'src/server/defence/generate.ts'), 'utf8'));
    const start = source.indexOf('grounding: {');
    expect(start, 'the grounding block is gone').toBeGreaterThan(-1);
    const grounding = source.slice(start, source.indexOf('},', start));

    // Every handle comes off the pack. A field read straight from the record
    // here would let the letter assert something no section contains.
    for (const field of [
      'permittedReferenceKeys',
      'verifiedCaseFields',
      'availableEvidenceRefs',
      'permittedNarrativeRefs',
      'reviewedLegalMaterial',
    ]) {
      expect(grounding, `${field} is no longer supplied to the drafter`).toContain(field);
    }
    expect(grounding).toMatch(/pack\.permittedReferences/);
  });

  it('never lets an unreviewed reference be quoted at a council', () => {
    const source = withoutComments(readFileSync(BUILD, 'utf8'));
    const start = source.indexOf('function permittedReferences');
    const body = source.slice(start);
    // Every ground, contravention and procedure record is PENDING_LEGAL_REVIEW,
    // so this filter is currently the difference between citing nothing and
    // citing something nobody has checked.
    expect(body).toMatch(/reviewStatus === 'REVIEWED'/);
  });

  it('keeps the letter out of the record', () => {
    /*
     * Section 7: editing the challenge must not alter a case fact, an evidence
     * fact or a finding. The guarantee is that the edit path writes one column,
     * so the rest is not addressable rather than merely protected.
     */
    const source = withoutComments(readFileSync(resolve(ROOT, 'src/server/defence/persist.ts'), 'utf8'));
    const start = source.indexOf('export async function saveEditedBody');
    const body = source.slice(start, source.indexOf('\n/* ---', start));

    /*
     * Read the update's own object literal rather than the whole function.
     * Scanning the function for column names catches its own `packId`
     * parameter, and a guard that trips on the correct code is one the next
     * person loosens until it stops complaining.
     */
    const update = body.slice(body.indexOf('.update({'), body.indexOf('})', body.indexOf('.update({')));
    const columns = [...update.matchAll(/(\w+):/g)].map((match) => match[1]);

    expect(columns.sort()).toEqual(['edited_at', 'edited_body']);
  });

  it('cannot give the paid product away by copying an environment variable', () => {
    const source = withoutComments(readFileSync(resolve(ROOT, 'src/server/defence/access.ts'), 'utf8'));
    const start = source.indexOf('export function previewAccessAvailable');
    const body = source.slice(start, source.indexOf('}', start) + 1);

    // Two conditions, and one of them is not an environment variable.
    expect(body).toContain('featureFlags.defencePackPreview');
    expect(body).toMatch(/NODE_ENV !== 'production'/);
  });
});

describe('routes that read live data are not prerendered', () => {
  const APP = resolve(ROOT, 'src/app');
  const REPOSITORIES = resolve(ROOT, 'src/server/repositories');

  /**
   * Repository modules that actually query the database, derived rather than
   * listed: a module is live if it imports the database reader. A hand-written
   * list would go stale the first time someone adds one.
   */
  const liveRepositories = readdirSync(REPOSITORIES)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => readFileSync(resolve(REPOSITORIES, f), 'utf8').includes('@/server/db/reader'))
    .map((f) => f.replace(/\.ts$/, ''));

  function routeFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...routeFiles(path));
      else if (/^(page|route|sitemap)\.tsx?$/.test(entry.name)) out.push(path);
    }
    return out;
  }

  it('derives which repositories are live rather than trusting a list', () => {
    expect(liveRepositories).toContain('enforcement');
    expect(liveRepositories).toContain('contravention-labels');
    // A module of constants is not a database read, and treating it as one
    // would flag pages that are correctly prerendered.
    expect(liveRepositories).not.toContain('authorities-data');
  });

  it('opts every prerenderable one out of static generation', () => {
    const offenders: string[] = [];
    for (const file of routeFiles(APP)) {
      const relative = file.replace(`${ROOT}/`, '');
      // A dynamic segment already forces per-request rendering without
      // generateStaticParams, so those routes were never frozen.
      if (relative.includes('[')) continue;

      const source = readFileSync(file, 'utf8');
      const readsLiveData = liveRepositories.some((repo) =>
        source.includes(`@/server/repositories/${repo}`),
      );
      if (!readsLiveData) continue;

      const optsOut = /export const dynamic\s*=\s*'force-dynamic'/.test(source);
      const usesSearchParams = source.includes('searchParams');
      if (!optsOut && !usesSearchParams) offenders.push(relative);
    }
    expect(
      offenders,
      'these routes read live data and would be prerendered, freezing whatever the database said at build time',
    ).toEqual([]);
  });
});

/**
 * A filter may only offer options that exist in the data.
 *
 * The contravention filter on /hotspots was a hardcoded list of twelve codes.
 * Against real Camden data it offered six the borough may never have issued —
 * clicking one showed an empty ranking, which reads as "no enforcement here"
 * rather than "that code is not in this data" — while hiding three of the four
 * most common, including two with roughly 75,000 notices each.
 */
describe('the read pool can reach a transaction pooler', () => {
  const reader = readFileSync(resolve(ROOT, 'src/server/db/reader.ts'), 'utf8');

  it('sets no startup parameter a pooler in transaction mode would refuse', () => {
    // node-postgres sends statement_timeout, lock_timeout and
    // idle_in_transaction_session_timeout in the StartupMessage. A pooler in
    // transaction mode rejects a connection carrying startup parameters it does
    // not track, so these fail the connection outright rather than making a
    // query slow — and serverless deployments have to use that pooler.
    // Searched forward from the constructor: `return pool;` also appears above
    // it, in the memoisation check, and slicing to that gave an empty string —
    // a guard that passed because it was examining nothing at all.
    const start = reader.indexOf('new Pool(');
    const poolConfig = reader.slice(start, reader.indexOf('return pool;', start));
    expect(poolConfig).toContain('connectionString');
    for (const forbidden of [
      'statement_timeout',
      'lock_timeout',
      'idle_in_transaction_session_timeout',
      'options:',
    ]) {
      // Named in a comment is fine; passed as configuration is not.
      const configured = new RegExp(`^\\s*${forbidden.replace(':', '')}\\s*:`, 'm');
      expect(configured.test(poolConfig), `${forbidden} must not be a pool option`).toBe(false);
    }
  });

  it('still bounds a slow read, client-side', () => {
    expect(reader).toMatch(/query_timeout:\s*[\d_]+/);
    expect(reader).toMatch(/connectionTimeoutMillis:\s*[\d_]+/);
  });

  it('keeps the ingestion timeout out of the request path', () => {
    // The ingestion pool allows ten minutes for a borough-sized batch. That
    // ceiling must never be what a visitor's map query is held to.
    const ingestion = readFileSync(
      resolve(ROOT, 'src/server/ingestion/postgres/aggregate-run.ts'),
      'utf8',
    );
    expect(ingestion).toMatch(/statement_timeout/);
    expect(reader).not.toMatch(/600_000|600000/);
  });
});

describe('the analyse flow does not keep facts inside a step', () => {
  const flow = readFileSync(resolve(ROOT, 'src/app/analyse/AnalyseFlow.tsx'), 'utf8');

  it('reads the notice type from state, not from the current step', () => {
    // It lived on the VERIFY step object. Pressing "Edit verified details"
    // moves to another step, which destroyed it, and the reassessment saw
    // UNKNOWN — so a recognised council PCN came back unsupported. Anything
    // that survives an edit has to live outside the step.
    expect(flow).not.toMatch(/step\.noticeType/);
    // Any conditional that makes the notice type depend on the current step
    // reintroduces the fault, whatever the variable is called.
    expect(flow).not.toMatch(/kind === 'VERIFY'[^;]{0,80}[Nn]oticeType/);
    expect(flow).toMatch(/readNoticeType/);
  });

  it('returns to the verification step when editing, not to the manual form', () => {
    // The manual form lists seven fields against the fourteen the reader
    // fills in; dropping to it hid the rest while still submitting them.
    expect(flow).toMatch(/verifySnapshot/);
  });
});

describe('filters offer only what the data contains', () => {
  it('builds the contravention filter from the database, not a literal', () => {
    const source = readFileSync(resolve(ROOT, 'src/app/hotspots/page.tsx'), 'utf8');

    // A literal array of two-digit strings is the shape the old bug had.
    const hardcodedCodeList = /\[\s*'\d{2}'\s*,\s*'\d{2}'/.test(source);
    expect(hardcodedCodeList, 'contravention codes must come from the data, not a literal list').toBe(
      false,
    );
    expect(source).toContain('getContraventionFilters');
  });
});
