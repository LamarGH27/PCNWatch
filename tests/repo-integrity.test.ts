import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
