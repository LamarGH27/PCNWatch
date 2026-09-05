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
