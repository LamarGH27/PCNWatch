import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What a buyer is told before they pay.
 *
 * Access to a purchased Defence Pack is tied to the browser that bought it:
 * there is no account, so clearing site data leaves the entitlement intact on
 * our side and removes the user's way back to it. That was disclosed on the
 * cases list and in the assessment, and nowhere on the surface where money
 * changes hands — which is the one place it has to be, now that money does.
 *
 * Asserted against the component's source rather than a render, because the
 * project has no component-render harness and the paywall surface is
 * unreachable in the browser suite: that build has no Supabase, so
 * `/case/<id>/defence` answers "Sign in to see this case" and the purchase card
 * never mounts. Source is the honest thing available; the alternative was a
 * test that could not fail.
 */

const CTA = 'src/app/case/[id]/defence/PurchaseCta.tsx';

/** The sentence, exactly as it must reach a buyer. */
const DISCLOSURE_OPENING = 'Your Defence Pack is linked to this browser for now.';
const DISCLOSURE = [
  DISCLOSURE_OPENING,
  'Keep this browser and its data available so you can return to your case.',
  'Account recovery is coming later.',
];

/** JSX wraps prose across lines; compare on one line. */
function prose(path: string): string {
  return readFileSync(path, 'utf8').replace(/\s+/g, ' ');
}

/**
 * Removes every `{cond && ( … )}` block opened by `marker`, brackets balanced.
 *
 * A regex cannot do this: the block contains its own braces and parentheses.
 */
function stripBalanced(source: string, marker: string): string {
  let out = source;
  for (;;) {
    const start = out.indexOf(marker);
    if (start === -1) return out;
    let depth = 0;
    let i = start + marker.length - 1; // at the opening '('
    for (; i < out.length; i += 1) {
      if (out[i] === '(') depth += 1;
      else if (out[i] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    // Past the ')' and its closing '}'.
    const end = out.indexOf('}', i);
    if (end === -1) return out.slice(0, start);
    out = out.slice(0, start) + out.slice(end + 1);
  }
}

describe('the browser-access disclosure on the purchase surface', () => {
  it('says all three sentences, verbatim', () => {
    const source = prose(CTA);
    for (const sentence of DISCLOSURE) {
      expect(source, `missing: "${sentence}"`).toContain(sentence);
    }
  });

  it('sits on the pre-payment surface, not only after checkout returns', () => {
    /*
     * The component returns early for CONFIRMING and SLOW — the panels shown
     * after a payment. The disclosure has to be in the final return, which is
     * what an unpaid visitor sees.
     */
    const source = readFileSync(CTA, 'utf8');
    const lastReturn = source.lastIndexOf('  return (');
    expect(lastReturn).toBeGreaterThan(-1);
    const preSale = source.slice(lastReturn);
    expect(preSale, 'the disclosure is not on the pre-payment surface').toContain(DISCLOSURE_OPENING);
  });

  it('shows whether or not checkout is enabled', () => {
    /*
     * The Stripe note is inside `{paymentsEnabled && ( … )}`. This must not be:
     * a deployment with payments off still shows somebody their case, and the
     * fact about browser-bound access is true either way.
     *
     * Checked by deleting every `paymentsEnabled` block and asserting the
     * disclosure survives. The first version of this test counted braces and
     * passed when the disclosure was deliberately wrapped in one — a guard that
     * cannot catch the thing it guards is worse than none.
     */
    const source = readFileSync(CTA, 'utf8');
    const withoutGated = stripBalanced(source, '{paymentsEnabled && (');
    expect(withoutGated, 'the disclosure is gated behind paymentsEnabled').toContain(DISCLOSURE_OPENING);
  });

  it('is quiet rather than an alert', () => {
    // It is a fact about how the product works, not an error. An alert role or
    // the urgent colour would frighten people off a purchase that is fine.
    const source = readFileSync(CTA, 'utf8');
    const at = source.indexOf(DISCLOSURE_OPENING);
    const element = source.slice(source.lastIndexOf('<p', at), at);
    expect(element).not.toMatch(/role=["']alert["']/);
    expect(element).not.toMatch(/--color-urgent|--color-critical/);
    // Readable: the faint token measures 4.94:1 on the card ground, above AA.
    expect(element).toMatch(/--text-faint|--text-muted/);
  });

  it('does not imply an account or email recovery exists today', () => {
    const source = prose(CTA);
    const at = source.indexOf(DISCLOSURE_OPENING);
    const sentence = source.slice(at, at + 260);
    for (const forbidden of [/sign in/i, /log in/i, /your account/i, /email you/i, /we will email/i, /password/i]) {
      expect(sentence, `implies something that does not exist: ${forbidden}`).not.toMatch(forbidden);
    }
    // "coming later" is a statement of intent, not of a feature that exists.
    expect(sentence).toContain('coming later');
  });
});

describe('the sitemap lists the page the product converts on', () => {
  const SITEMAP = 'src/app/sitemap.ts';

  it('includes /analyse', () => {
    const source = readFileSync(SITEMAP, 'utf8');
    expect(source).toContain('${base}/analyse');
  });

  it('builds every entry from NEXT_PUBLIC_SITE_URL', () => {
    const source = readFileSync(SITEMAP, 'utf8');
    expect(source).toContain("publicEnv.NEXT_PUBLIC_SITE_URL.replace(/\\/$/, '')");
    // No entry may hardcode a host.
    const urls = [...source.matchAll(/url: `([^`]+)`/g)].map((m) => m[1]);
    expect(urls.length).toBeGreaterThan(5);
    for (const url of urls) {
      expect(url, `${url} does not derive from the site URL`).toMatch(/^\$\{base\}/);
    }
  });

  it('keeps /analyse indexable, and robots does not block it', () => {
    const page = readFileSync('src/app/analyse/page.tsx', 'utf8').replace(/\s+/g, ' ');
    expect(page).toMatch(/robots: \{ index: true, follow: true \}/);

    /*
     * robots.txt disallows `/analyse/` with a trailing slash, which blocks
     * paths below it and not `/analyse` itself. If the slash were ever dropped
     * the canonical route would be blocked while still being listed — a
     * sitemap entry a crawler is told to ignore.
     */
    const robots = readFileSync('src/app/robots.ts', 'utf8');
    expect(robots).toContain("'/analyse/'");
    expect(robots).not.toMatch(/disallow:[^\]]*'\/analyse'/);
  });

  it('lists no private case route', () => {
    const source = readFileSync('src/app/sitemap.ts', 'utf8');
    for (const priv of ['/case/', '/cases', '/admin', '/api/']) {
      expect(source, `${priv} must never be in the sitemap`).not.toContain(`\${base}${priv}`);
    }
  });
});
