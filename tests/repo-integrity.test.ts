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
describe('a written account is not kept anywhere', () => {
  const CLIENT = resolve(ROOT, 'src/server/ai/client.ts');

  it('marks narrative extraction as a private-input job', () => {
    const source = readFileSync(CLIENT, 'utf8');
    const start = source.indexOf('const PRIVATE_INPUT_JOBS');
    expect(start, 'the private-input policy is gone').toBeGreaterThan(-1);
    expect(source.slice(start, source.indexOf(';', start))).toContain('NARRATIVE_EXTRACTION');
  });

  it('does not persist the output of a private-input job', () => {
    const source = readFileSync(CLIENT, 'utf8');
    // The summaries are drawn from the account and can restate it nearly word
    // for word, so storing them stores the account under another name.
    expect(source).toMatch(/output:\s*isPrivateInput\s*\?\s*null\s*:\s*raw/);
  });

  it('does not fingerprint a private-input job by its content', () => {
    const source = readFileSync(CLIENT, 'utf8');
    expect(source).toMatch(/hashText:\s*!isPrivateInput/);
  });

  it('has no column the account could be written to', () => {
    /*
     * The strongest form of this rule, and the reason it is a migration rather
     * than a convention: `user_narrative` existed in 0004 and was never used,
     * which is one `insert` away from being used. 0014 drops it.
     *
     * Checked against the migrations rather than a live database so it holds
     * before anything is deployed.
     */
    const migrations = readdirSync(resolve(ROOT, 'supabase/migrations'))
      .filter((f) => f.endsWith('.sql'))
      .sort();

    const dropped = migrations.some((f) =>
      /alter table pcn_cases drop column if exists user_narrative/i.test(
        readFileSync(resolve(ROOT, 'supabase/migrations', f), 'utf8'),
      ),
    );
    expect(dropped, 'the narrative column is no longer dropped by a migration').toBe(true);

    // And nothing added it back afterwards.
    const afterDrop = migrations.slice(
      migrations.findIndex((f) =>
        /drop column if exists user_narrative/i.test(
          readFileSync(resolve(ROOT, 'supabase/migrations', f), 'utf8'),
        ),
      ) + 1,
    );
    for (const file of afterDrop) {
      expect(
        readFileSync(resolve(ROOT, 'supabase/migrations', file), 'utf8'),
        `${file} adds a narrative column back`,
      ).not.toMatch(/add column[^;]*user_narrative/i);
    }
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
