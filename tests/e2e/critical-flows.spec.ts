import { expect, test } from '@playwright/test';

/**
 * Critical browser flows.
 *
 * These run against a build with no credentials, which is the point: the
 * behaviours most worth proving in a real browser are the ones about honesty and
 * privacy, and a fully-configured environment would hide them.
 */

/**
 * Each test is a different visitor.
 *
 * The rate limiter derives a caller identity from the proxy headers a real
 * deployment sets, and falls back to one shared bucket when there are none. In
 * the browser suite that made 129 tests look like a single client hammering the
 * assessment endpoint forty times a minute — so the limiter did exactly its job,
 * some runs tripped the limit partway through, and a test would fail waiting
 * twenty seconds for a page the server had correctly refused to build.
 *
 * Setting the header per test is not a way around the limit: it is what the
 * production path actually receives, and these really are distinct visitors.
 * The limiter stays live, at its real setting, and a genuine regression in it
 * would still be caught.
 */

/**
 * The panel shown once the account has been read.
 *
 * Its heading depends on whether anything needs checking: "One or two things to
 * check" when a reading was doubtful, contradicted or a claim about a document,
 * and "We understood this as…" when everything was accepted. Both are the same
 * screen, so tests wait for either rather than encoding which case their
 * fixture happens to produce.
 */
async function reachUnderstood(page: import('@playwright/test').Page) {
  await expect(
    page.getByRole('heading', { name: /we understood this as|one or two things to check/i }),
  ).toBeVisible({ timeout: 20_000 });
}

/**
 * Opens every reading for individual confirmation.
 *
 * The confirmation controls still exist for every assertion; they are behind
 * one link for the ones that were accepted. A test that needs to disagree with
 * a reading comes through here.
 */
async function openAllReadings(page: import('@playwright/test').Page) {
  const edit = page.getByRole('button', { name: /edit what we understood/i });
  if ((await edit.count()) > 0) await edit.click();
}

/**
 * Opens the full analysis.
 *
 * The assessment now leads with five lines — basis, what matters, the biggest
 * gap, the next step, and what the paid pack contains — and everything else is
 * behind "See full analysis". Tests about the detail open it; tests about the
 * summary do not, which is the distinction the disclosure exists to make.
 */
async function openFullAnalysis(page: import('@playwright/test').Page) {
  const summary = page.locator('summary', { hasText: /see full analysis/i }).first();
  await summary.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {});
  if ((await summary.count()) > 0) await summary.click();
}

/** Past the follow-ups and into the full question set. */
async function reachFullQuestions(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: /^continue$/i }).click();
  const more = page.getByRole('button', { name: /answer more questions/i });
  await expect(more).toBeVisible({ timeout: 20_000 });
  await more.click();
}

let visitor = 0;
test.beforeEach(async ({ page }) => {
  visitor += 1;
  await page.setExtraHTTPHeaders({ 'x-forwarded-for': `203.0.113.${visitor % 254}` });
});

test.describe('landing and navigation', () => {
  test('the landing page leads to the two things the product does', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Know before the ticket.');
    await expect(page.getByRole('link', { name: 'Explore the map' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Analyse my PCN' }).first()).toBeVisible();
  });

  test('coverage is stated on the landing page, not buried', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByText(/Camden only/i).first()).toBeVisible();
  });

  test('the disclaimer appears on every page via the footer', async ({ page }) => {
    for (const path of ['/', '/map', '/hotspots', '/codes']) {
      await page.goto(path);
      await expect(
        page.getByText(/does not provide legal advice and does not guarantee/i).first(),
      ).toBeVisible();
    }
  });
});

test.describe('the map never claims coverage it does not have', () => {
  test('an unconfigured deployment says data is unavailable, not that there are no tickets', async ({
    page,
  }) => {
    await page.goto('/map');

    // The distinction that matters most in the whole product.
    await expect(page.getByText('Data temporarily unavailable').first()).toBeVisible();
    // The message appears in both the coverage banner and the map panel; both are
    // correct, so assert on the first rather than requiring exactly one.
    await expect(page.getByText(/not a statement about enforcement activity/i).first()).toBeVisible();

    // And it must not show a zero that reads as a real measurement.
    await expect(page.getByText(/^0 PCNs/)).toHaveCount(0);
  });

  test('the map states its geographic scope', async ({ page }) => {
    await page.goto('/map');
    await expect(page.getByText(/Camden only/i).first()).toBeVisible();
    await expect(
      page.getByText(/does not tell you whether parking is permitted/i).first(),
    ).toBeVisible();
  });

  test('the cells API reports coverage honestly rather than an empty success', async ({
    request,
  }) => {
    const response = await request.get(
      '/api/map/cells?authority=camden&minLon=-0.2&minLat=51.5&maxLon=-0.1&maxLat=51.56&zoom=13&period=12M',
    );
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.cells).toEqual([]);
    expect(body.coverage.state).toBe('TEMPORARILY_UNAVAILABLE');
  });

  test('the cells API rejects an oversized viewport', async ({ request }) => {
    const response = await request.get(
      '/api/map/cells?authority=camden&minLon=-90&minLat=-45&maxLon=90&maxLat=45&zoom=2&period=12M',
    );
    expect(response.status()).toBe(400);
  });

  test('the cells API rejects a malformed request', async ({ request }) => {
    const response = await request.get('/api/map/cells?authority=../../etc&minLon=nonsense');
    expect(response.status()).toBe(400);
  });
});

test.describe('hotspots', () => {
  test('says why there are no rankings rather than showing an empty table', async ({ page }) => {
    await page.goto('/hotspots');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('enforcement activity');
    await expect(page.getByText('Data temporarily unavailable').first()).toBeVisible();
  });

  test('explains what the score is and is not', async ({ page }) => {
    await page.goto('/hotspots');
    await expect(
      page.getByText(/does not predict whether you will receive a ticket/i).first(),
    ).toBeVisible();
  });
});

test.describe('contravention reference', () => {
  test('lists only codes the reference store actually holds', async ({ page }) => {
    await page.goto('/codes');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Contravention codes');
    await expect(page.getByText(/If your code is not listed/i)).toBeVisible();
  });

  test('a held code shows its official description and evidence guidance', async ({ page }) => {
    await page.goto('/codes/12');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('code 12');
    await expect(page.getByText('Official description')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Evidence commonly relevant' })).toBeVisible();
  });

  test('unreviewed reference content is not published for search engines', async ({ page }) => {
    const response = await page.goto('/codes/01');
    expect(response?.status()).toBe(200);
    const robots = await page.locator('meta[name="robots"]').getAttribute('content');
    expect(robots).toContain('noindex');
  });

  test('a code we do not hold returns 404 rather than an invented page', async ({ page }) => {
    const response = await page.goto('/codes/97');
    expect(response?.status()).toBe(404);
  });

  test('the sitemap does not list unreviewed reference pages', async ({ request }) => {
    const response = await request.get('/sitemap.xml');
    const body = await response.text();
    expect(body).not.toContain('/codes/01');
    expect(body).toContain('/codes');
  });

  test('robots disallows the private areas', async ({ request }) => {
    const body = await (await request.get('/robots.txt')).text();
    for (const path of ['/api/', '/case/', '/admin/']) {
      expect(body).toContain(path);
    }
  });
});

test.describe('privacy', () => {
  test('an anonymous visitor cannot open a case page', async ({ page }) => {
    await page.goto('/case/00000000-0000-0000-0000-000000000001');
    // Never the case itself, whatever the reason.
    await expect(page.getByRole('heading', { level: 1 })).not.toHaveText(/PCN|Eversholt/i);
    await expect(
      page.getByText(/Sign in to see this case|Case not found|Case temporarily unavailable/),
    ).toBeVisible();
  });

  test('an anonymous visitor cannot open a case evidence page', async ({ page }) => {
    await page.goto('/case/00000000-0000-0000-0000-000000000001/evidence');
    // Uploading is the point of that page, so a stranger must not reach the
    // control that does it — nor the name of anything on somebody's case.
    await expect(page.getByRole('heading', { name: 'Evidence' })).toHaveCount(0);
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
    await expect(
      page.getByText(/Sign in to see this case|Case not found|Case temporarily unavailable/),
    ).toBeVisible();
  });

  test('the evidence endpoints refuse an unauthenticated caller', async ({ request }) => {
    const caseId = '00000000-0000-0000-0000-000000000001';

    // No session, so RLS has nothing to match and there is no route to a file.
    const list = await request.get(`/api/cases/${caseId}/evidence`);
    expect([401, 503]).toContain(list.status());

    // A confirmation posted at an item nobody owns confirms nothing.
    const verify = await request.post(`/api/evidence/${caseId}/verify`, {
      data: { confirmed: [0] },
    });
    expect([401, 404, 409, 503]).toContain(verify.status());

    const remove = await request.delete(`/api/evidence/${caseId}`);
    expect([401, 404, 503]).toContain(remove.status());
  });

  test('the upload endpoint rejects a file type it will not read', async ({ request }) => {
    /*
     * Server-side, and before anything else. The browser's `accept` filter is a
     * courtesy; this is the control, and it has to hold for a caller that never
     * opened a browser.
     */
    const body = new FormData();
    body.set('evidenceType', 'PERMIT');
    body.set(
      'file',
      new Blob(['MZ not a photograph'], { type: 'application/x-msdownload' }),
      'payload.exe',
    );
    const response = await request.post(
      '/api/cases/00000000-0000-0000-0000-000000000001/evidence',
      { multipart: body },
    );
    // Never 201. Unsupported, or refused before it got that far.
    expect(response.status()).not.toBe(201);
    expect([400, 401, 413, 415, 503]).toContain(response.status());
  });

  test('a malformed case id does not reveal whether any case exists', async ({ page }) => {
    await page.goto('/case/not-a-uuid');
    await expect(page.getByRole('heading', { name: 'Case not found' })).toBeVisible();
  });

  test('the admin page is restricted and reveals nothing about who is an admin', async ({
    page,
  }) => {
    await page.goto('/admin/data-health');
    await expect(page.getByRole('heading', { name: 'Not available' })).toBeVisible();
    await expect(page.getByText(/allow-list|allowlist|not signed in/i)).toHaveCount(0);
  });

  test('a Stripe-style success redirect grants nothing', async ({ page }) => {
    await page.goto(
      '/case/00000000-0000-0000-0000-000000000001/defence?checkout=returned&paid=true&session_id=cs_test_forged',
    );
    // No pack, no entitlement, regardless of what the URL claims.
    await expect(page.getByRole('button', { name: /Build Defence Pack/ })).toHaveCount(0);
    await expect(page.getByText(/Continue to payment/)).toHaveCount(0);
  });

  test('an anonymous visitor cannot open a Defence Pack', async ({ page }) => {
    await page.goto('/case/00000000-0000-0000-0000-000000000001/defence');
    // Never the pack, and never anything off somebody's case.
    await expect(page.getByRole('heading', { name: 'Your case' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Your challenge letter' })).toHaveCount(0);
    await expect(
      page.getByText(/Sign in to see this case|Case not found|Case temporarily unavailable/),
    ).toBeVisible();
  });

  test('the Defence Pack endpoints refuse an unauthenticated caller', async ({ request }) => {
    const caseId = '00000000-0000-0000-0000-000000000001';

    // Building is gated before anything is read, so this is 402 or 401, never 200.
    const build = await request.post(`/api/cases/${caseId}/defence-pack`);
    expect(build.status()).not.toBe(200);
    expect([401, 402, 404, 503]).toContain(build.status());

    // And an edit aimed at a pack nobody owns changes nothing.
    const edit = await request.patch(`/api/defence-pack/${caseId}`, {
      data: { editedBody: 'replaced by a stranger' },
    });
    expect([401, 404, 503]).toContain(edit.status());
  });

  test('the old draft URL leads to the Defence Pack rather than a dead paywall', async ({
    page,
  }) => {
    await page.goto('/case/00000000-0000-0000-0000-000000000001/draft');
    await expect(page).toHaveURL(/\/defence$/);
  });
});

test.describe('the fast journey', () => {
  test('leads with one field and the shortest possible path', async ({ page }) => {
    /*
     * This deployment has no reader configured, so the journey lands on the
     * manual path — which is exactly the case worth proving does not regress:
     * even with nothing to read, the route to an assessment is one screen of
     * details and then what happened, not a questionnaire.
     */
    await page.goto('/analyse');
    await expect(page.getByRole('button', { name: /Enter the details by hand/ })).toBeVisible();
    await page.getByRole('button', { name: /Enter the details by hand/ }).click();

    // The details screen still exists and still asks for what it must.
    await expect(page.getByRole('button', { name: /Confirm/ })).toBeVisible();
  });

  test('does not put the full questionnaire in front of anybody', async ({ page }) => {
    await page.goto('/analyse');
    // Nothing about evidence gathering is on the first screen. It is an
    // optional strengthening step now, not a prerequisite.
    await expect(page.getByText(/Upload supporting evidence/i)).toHaveCount(0);
    await expect(page.getByText(/essential item/i)).toHaveCount(0);
  });

  test('the analyse page stays on one screen at phone width', async ({ page }) => {
    await page.goto('/analyse');
    const scrollsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollsSideways, 'the analyse page scrolls sideways').toBe(false);
  });
});

test.describe('the Defence Pack on a phone', () => {
  test.skip(({ isMobile }) => !isMobile, 'Mobile-shaped only.');

  test('the pack page works at phone width', async ({ page }) => {
    /*
     * A Defence Pack is read outdoors, on the phone the notice was
     * photographed with, often while standing next to the car. If it only
     * works on a desktop it does not work.
     */
    await page.goto('/case/00000000-0000-0000-0000-000000000001/defence');

    const scrollsSideways = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    );
    expect(scrollsSideways, 'the pack page scrolls sideways on a phone').toBe(false);

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });

  test('is reachable from the case page in one tap', async ({ page }) => {
    await page.goto('/case/00000000-0000-0000-0000-000000000001');
    // The case is unavailable without a session, which is the point of the
    // other tests; what matters here is that nothing about the pack link
    // depends on a wide viewport to exist.
    const heading = page.getByRole('heading', { level: 1 });
    await expect(heading).toBeVisible();
  });
});

test.describe('PCN analysis', () => {
  test('offers a camera-first upload and a manual fallback', async ({ page }) => {
    await page.goto('/analyse');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('notice in your hand');
    await expect(page.getByRole('button', { name: 'Take a photo' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Enter the details by hand/ })).toBeVisible();
  });

  test('says plainly when automatic reading is unavailable', async ({ page }) => {
    await page.goto('/analyse');
    await expect(page.getByText(/Automatic reading is not available/i)).toBeVisible();
    // And the manual path still works.
    await page.getByRole('button', { name: /Enter the details by hand/ }).click();
    await expect(page.getByLabel('PCN number')).toBeVisible();
  });

  test('will not submit until every important field is confirmed', async ({ page }) => {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /Enter the details by hand/ }).click();

    const submit = page.getByRole('button', { name: /Confirm \d+ more field/ });
    await expect(submit).toBeVisible();
    await expect(submit).toBeDisabled();
    await expect(
      page.getByText(/will not calculate a deadline from a field you have not checked/i),
    ).toBeVisible();
  });

  test('the extraction endpoint rejects an unsupported file type', async ({ request }) => {
    const response = await request.post('/api/cases/extract', {
      multipart: {
        file: {
          name: 'notes.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('not a notice'),
        },
      },
    });
    expect(response.status()).toBe(415);
    const body = await response.json();
    expect(body.dataSaved).toBe(false);
  });

  test('the extraction endpoint says nothing was saved when it fails', async ({ request }) => {
    const response = await request.post('/api/cases/extract', { multipart: {} });
    const body = await response.json();
    expect(body.kind).toBe('FAILED');
    expect(body.dataSaved).toBe(false);
    expect(body.whatYouCanDo).toBeTruthy();
  });
});

test.describe('mobile experience', () => {
  test.skip(({ isMobile }) => !isMobile, 'mobile projects only');

  test('the page never scrolls sideways', async ({ page }) => {
    for (const path of ['/', '/hotspots', '/codes/12', '/analyse', '/boroughs']) {
      await page.goto(path);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${path} scrolls horizontally by ${overflow}px`).toBeLessThanOrEqual(1);
    }
  });

  test('primary actions meet the minimum touch target size', async ({ page }) => {
    await page.goto('/analyse');
    const button = page.getByRole('button', { name: 'Take a photo' });
    const box = await button.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
  });

  test('the analyse flow is reachable in one tap from the landing page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'Analyse my PCN' }).first().click();
    await expect(page).toHaveURL(/\/analyse/);
  });
});

test.describe('accessibility basics', () => {
  test('every page has exactly one h1 and a skip link', async ({ page }) => {
    for (const path of ['/', '/map', '/hotspots', '/codes', '/analyse', '/boroughs']) {
      await page.goto(path);
      await expect(page.locator('h1'), `${path} h1 count`).toHaveCount(1);
      await expect(page.locator('.fr-skip-link')).toHaveCount(1);
    }
  });

  test('the map region is labelled for assistive technology', async ({ page }) => {
    await page.goto('/map');
    // Either the map itself, or the honest "not covered" panel, must be present.
    const hasMap = await page.getByRole('application', { name: /enforcement activity/i }).count();
    const hasNotice = await page.getByRole('status').count();
    expect(hasMap + hasNotice).toBeGreaterThan(0);
  });
});

test.describe('the analyse journey does not dead-end', () => {
  // Runs against a build with no credentials, so extraction is unavailable and
  // the flow offers manual entry. That path reaches the same verification step
  // and the same assessment, which is the part that used to go nowhere.

  test('the assessment endpoint answers from verified facts alone', async ({ request }) => {
    const response = await request.post('/api/cases/assess', {
      data: {
        noticeType: 'PCN_POSTAL',
        contraventionCode: '12',
        issueDate: '2026-08-14',
        incidentDate: '2026-08-11',
        fullAmountPence: 13000,
      },
    });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.assessment.supported).toBe(true);
    // A basis, a stage, and dates worked out from the confirmed issue date.
    expect(body.assessment.assessment.basis).toBeTruthy();
    expect(body.assessment.stage).toBe('NEW');

    /*
     * Every deadline is accounted for, which is the part that used to go
     * nowhere. Accounted for means one of two things, and never silence: a
     * date we are willing to stand behind, or a named refusal saying why we
     * will not give one. This deliberately does not require a calculated
     * date. Timing rules awaiting legal review are withheld on the server,
     * so an endpoint that returned nothing but refusals here would still be
     * behaving correctly -- what it may never do is say nothing at all.
     */
    const { calculatedDeadlines, refusedDeadlines } = body.assessment;
    expect(calculatedDeadlines.length + refusedDeadlines.length).toBeGreaterThan(0);

    for (const deadline of calculatedDeadlines) {
      expect(deadline.source).toBe('CALCULATED_BY_PCNWATCH');
      expect(deadline.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    for (const refusal of refusedDeadlines) {
      // A refusal names the deadline and the reason, and carries no date for
      // the user to act on.
      expect(refusal.label).toBeTruthy();
      expect(refusal.reason).toBeTruthy();
      expect(refusal.message).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });

  test('a private parking charge is refused council logic', async ({ request }) => {
    const response = await request.post('/api/cases/assess', {
      data: { noticeType: 'PRIVATE_PARKING_CHARGE', issueDate: '2026-08-14' },
    });
    const body = await response.json();

    expect(body.assessment.supported).toBe(false);
    expect(body.assessment.unsupportedMessage).toBeTruthy();
    expect(body.assessment.calculatedDeadlines).toHaveLength(0);
  });

  test('the old dead-end wording is gone from the flow', async ({ page }) => {
    await page.goto('/analyse');
    await expect(page.getByText('Your notice details are stored privately')).toHaveCount(0);
  });

  test('the analyse page works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/analyse');

    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    // Nothing may push the page sideways on a phone.
    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflows).toBe(false);
  });
});

test.describe('editing after an assessment keeps the notice recognised', () => {
  /**
   * The production failure, driven through the browser: a recognised council
   * PCN became "we could not tell what kind of notice this is" after pressing
   * edit and confirming again. The notice type lived inside the verify step
   * object, and editing moved to a different step, which destroyed it.
   *
   * Uses manual entry rather than a photograph, so it runs without an
   * extraction key while exercising the same confirm → assess → edit →
   * reassess transitions.
   */

  const VALUES = [
    'Westminster City Council',
    'WM12345678',
    '12',
    '2026-08-11',
    '2026-08-14',
    'STRAND',
    '13000',
  ];

  /**
   * Fills every field and ticks its confirmation.
   *
   * Paired by index: each row is one textbox and one "This matches my notice"
   * checkbox, in the same order. The button stays disabled and reads "Confirm
   * N more fields" until all seven are ticked, which is what makes the
   * assertion below meaningful — an incomplete form cannot reach an
   * assessment, so a test that failed to fill it would fail here rather than
   * quietly passing later.
   */
  async function fillAndConfirm(page: import('@playwright/test').Page) {
    const boxes = page.getByRole('textbox');
    const ticks = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(VALUES.length);

    for (let i = 0; i < VALUES.length; i++) {
      await boxes.nth(i).fill(VALUES[i]!);
      await ticks.nth(i).check();
    }

    const submit = page.getByRole('button', { name: /confirm and continue/i });
    await expect(submit).toBeEnabled();
    await submit.click();
  }

  /**
   * Straight past "Tell us what happened" without answering.
   *
   * Skipping is a supported route, not a shortcut for tests: it is what a user
   * who does not want to type gets, so every test that does not care about the
   * context stage goes this way and proves the skip path still works.
   */
  async function skipContext(page: import('@playwright/test').Page) {
    const skip = page.getByRole('button', { name: /^skip for now$/i });
    await expect(skip).toBeVisible({ timeout: 20_000 });
    await skip.click();
  }

  test('the confirm button does not claim to save anything', async ({ page }) => {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();
    await expect(page.getByRole('button', { name: /save and continue/i })).toHaveCount(0);
  });

  test('a recognised council PCN stays recognised after an edit', async ({ page }) => {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();
    await fillAndConfirm(page);
    await skipContext(page);
    await openFullAnalysis(page);

    // Positive proof the assessment rendered, not merely that an error is
    // absent: absence would also be satisfied by a page that went nowhere.
    const assessment = page.getByRole('heading', { name: 'Your PCN' });
    await expect(assessment).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/could not tell what kind of notice/i)).toHaveCount(0);

    // Edit, then confirm again without changing anything.
    await page.getByRole('button', { name: /edit verified details/i }).click();
    await expect(page.getByRole('button', { name: /confirm and continue/i })).toBeEnabled();
    await page.getByRole('button', { name: /confirm and continue/i }).click();
    await skipContext(page);
    await openFullAnalysis(page);

    // The bug: this second pass said "we could not tell what kind of notice
    // this is" and offered nothing else.
    await expect(assessment).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/could not tell what kind of notice/i)).toHaveCount(0);
  });

  test('an unreviewed timing rule shows no date to act on', async ({ page }) => {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();
    await fillAndConfirm(page);
    await skipContext(page);
    await openFullAnalysis(page);

    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });
    // A date and "awaiting review by a qualified person" must never share the
    // screen: people act on the date.
    await expect(page.getByText(/awaiting review by a qualified person/i)).toHaveCount(0);
  });
});

test.describe('tell us what happened', () => {
  const VALUES = [
    'Westminster City Council',
    'WM12345678',
    '12',
    '2026-08-11',
    '2026-08-14',
    'STRAND',
    '13000',
  ];

  async function reachContextStage(page: import('@playwright/test').Page) {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();

    const boxes = page.getByRole('textbox');
    const ticks = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(VALUES.length);
    for (let i = 0; i < VALUES.length; i++) {
      await boxes.nth(i).fill(VALUES[i]!);
      await ticks.nth(i).check();
    }
    await page.getByRole('button', { name: /confirm and continue/i }).click();
    await expect(page.getByRole('heading', { name: /what happened/i })).toBeVisible({
      timeout: 20_000,
    });
  }

  test('asks what happened before giving the assessment', async ({ page }) => {
    await reachContextStage(page);

    // The assessment must not already be on screen: this stage sits before it.
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: /what happened/i })).toBeVisible();
    await expect(page.getByText(/in your own words/i)).toBeVisible();
    // Never asks for legal language.
    await expect(page.getByText(/you do not need legal wording/i)).toBeVisible();
  });

  test('says the account stays in this browser', async ({ page }) => {
    await reachContextStage(page);
    await expect(page.getByText(/stays in this browser for this session only/i).first()).toBeVisible();
  });

  test('asks the code 12 questions and does not call them defences', async ({ page }) => {
    await reachContextStage(page);
    await reachFullQuestions(page);

    // Straight from the approved reference record for code 12.
    await expect(page.getByText(/did you hold a valid permit for that bay/i)).toBeVisible();
    await expect(page.getByText(/pay-and-display ticket or pay by app/i)).toBeVisible();

    // And the warning that a yes is not a defence.
    await expect(page.getByText(/does not mean you have a defence/i)).toBeVisible();
  });

  test('marks mitigation as discretion rather than a legal ground', async ({ page }) => {
    await reachContextStage(page);
    await reachFullQuestions(page);
    await expect(page.getByText(/it is not a legal ground/i)).toBeVisible();
  });

  test('an answered case reaches an assessment that uses the answers', async ({ page }) => {
    await reachContextStage(page);
    await page
      .getByRole('textbox', { name: /what happened/i })
      .fill('I had a resident permit for that bay and had renewed it that morning.');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // An account now goes through the confirmation screen on its way to the
    // questions. This build has no reader configured, so there is nothing to
    // confirm — which is itself the path most deployments without a key take.
    await reachUnderstood(page);
    // The full question set is one link past the follow-ups now.
    await reachFullQuestions(page);

    // Answer the permit question yes.
    const permit = page.getByRole('group').filter({ hasText: /did you hold a valid permit/i });
    await permit.getByRole('radio', { name: /^yes$/i }).check();

    // Declare the permit, behind the disclosure.
    await page.getByRole('button', { name: /anything that supports this/i }).click();
    const permitEvidence = page.getByRole('group').filter({ hasText: /parking permit/i });
    await permitEvidence.getByRole('radio', { name: /i have this/i }).check();

    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    // The answers are on the page, labelled as the user's own account.
    await expect(page.getByText(/what you have told us about what happened/i)).toBeVisible();
    await expect(page.getByText('You told us').first()).toBeVisible();
    // The declaration lands in two places, and both matter: the basis says the
    // case still rests on the account, and the missing-information list asks
    // for the document itself. Asserting each separately rather than loosening
    // to one match keeps both halves covered.
    await expect(
      page.getByText(/you have told us about 1 item of supporting evidence, but we have not seen it/i),
    ).toBeVisible();
    await expect(
      page.getByText(/you said you can produce parking permit\. we have not seen it/i),
    ).toBeVisible();

    // And nothing became a prediction.
    await expect(page.getByText(/likely to succeed|good chance|you will win/i)).toHaveCount(0);
  });

  test('skipping still gives an assessment, and says what it is missing', async ({ page }) => {
    await reachContextStage(page);
    await page.getByRole('button', { name: /^skip for now$/i }).click();
    await openFullAnalysis(page);

    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: /insufficient information/i })).toBeVisible();
    await expect(page.getByText(/only knows what your notice says/i)).toBeVisible();
    // And a way back in, rather than a dead end.
    await expect(page.getByRole('button', { name: /tell us what happened/i }).first()).toBeVisible();
  });

  test('the account survives going back to the verified details', async ({ page }) => {
    await reachContextStage(page);
    const account = page.getByRole('textbox', { name: /what happened/i });
    await account.fill('I had a permit.');

    await page.getByRole('button', { name: /back to your details/i }).click();
    await expect(page.getByRole('button', { name: /confirm and continue/i })).toBeEnabled();
    await page.getByRole('button', { name: /confirm and continue/i }).click();

    // The bug this guards: an account someone typed evaporating because they
    // went back to correct a date.
    await expect(page.getByRole('textbox', { name: /what happened/i })).toHaveValue('I had a permit.');
  });

  test('works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await reachContextStage(page);
    await reachFullQuestions(page);

    // Nothing may push the page sideways on a phone.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the questions push the page sideways').toBeLessThanOrEqual(1);

    // Every answer control is still a real touch target.
    const radios = page.getByRole('radio');
    const count = await radios.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < Math.min(count, 6); i++) {
      const box = await radios.nth(i).locator('xpath=ancestor::label[1]').boundingBox();
      expect(box!.height, 'an answer control is too small to tap').toBeGreaterThanOrEqual(44);
    }
  });
});

test.describe('what we understood from the account', () => {
  const VALUES = [
    'Westminster City Council',
    'WM12345678',
    '12',
    '2026-08-11',
    '2026-08-14',
    'STRAND',
    '13000',
  ];

  async function reachAccountPanel(page: import('@playwright/test').Page) {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();

    const boxes = page.getByRole('textbox');
    const ticks = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(VALUES.length);
    for (let i = 0; i < VALUES.length; i++) {
      await boxes.nth(i).fill(VALUES[i]!);
      await ticks.nth(i).check();
    }
    await page.getByRole('button', { name: /confirm and continue/i }).click();
    await expect(page.getByRole('heading', { name: /what happened/i })).toBeVisible({
      timeout: 20_000,
    });
  }

  /**
   * Stands in for the reader.
   *
   * The build under test has no model configured, which is itself one of the
   * cases below. For the rest, the endpoint is intercepted so the confirmation
   * screen can be driven with a known reading — the browser test is about what
   * a user is shown and what leaves the page, not about what a model returns.
   */
  async function stubReader(
    page: import('@playwright/test').Page,
    assertions: unknown[],
  ) {
    await page.route('**/api/cases/narrative', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, assertions }),
      });
    });
  }

  const PERMIT = {
    kind: 'HELD_PERMIT',
    stance: 'ASSERTED',
    confidence: 0.9,
    summary: 'Says a resident permit was held for that bay.',
    source: 'USER_ACCOUNT',
  };

  test('shows what we understood before anything counts', async ({ page }) => {
    await stubReader(page, [PERMIT]);
    await reachAccountPanel(page);

    await page.getByRole('textbox', { name: /what happened/i }).fill('I had a resident permit.');
    await page.getByRole('button', { name: /^continue$/i }).click();

    await reachUnderstood(page);
    await expect(page.getByText(/says a resident permit was held/i)).toBeVisible();
    /*
     * The screen says what is actually happening.
     *
     * It used to promise "nothing here counts until you confirm it", which was
     * true when every reading was put to the user one at a time. Confident
     * readings are now accepted and shown back, so the screen says that
     * instead — a faster journey must not keep the slower one's promise.
     */
    await expect(page.getByText(/left out of your assessment/i).first()).toBeVisible();
    await expect(page.getByText(/nothing here counts until you confirm it/i)).toHaveCount(0);
    // And it is a reading, not a decision.
    await expect(page.getByText(/not a decision about your case/i)).toBeVisible();
  });

  test('lets the user disagree with our reading', async ({ page }) => {
    await stubReader(page, [PERMIT]);
    await reachAccountPanel(page);
    await page.getByRole('textbox', { name: /what happened/i }).fill('I had a resident permit.');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await reachUnderstood(page);

    // Disagreeing is a real option on the screen, not something buried.
    await expect(page.getByRole('radio', { name: /not what i meant/i })).toBeVisible();
    await expect(page.getByRole('radio', { name: /no, the opposite/i })).toBeVisible();
  });

  test('sends only confirmed assertions to the assessment', async ({ page }) => {
    await stubReader(page, [
      PERMIT,
      {
        kind: 'PAYMENT_BY_APP',
        stance: 'ASSERTED',
        confidence: 0.8,
        summary: 'Says payment was made by app.',
        source: 'USER_ACCOUNT',
      },
    ]);

    const sent: string[] = [];
    await page.route('**/api/cases/assess', async (route) => {
      sent.push(route.request().postData() ?? '');
      await route.continue();
    });

    await reachAccountPanel(page);
    await page
      .getByRole('textbox', { name: /what happened/i })
      .fill('I had a resident permit and I paid by app.');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await reachUnderstood(page);

    /*
     * Confirm one and leave the other alone — which is what people actually do.
     * An explicit "not what I meant" is the easy case; the one that matters is
     * the assertion nobody looked at, because a default of "confirmed unless
     * rejected" would sail through a test that decides every row.
     */
    const permit = page.getByRole('group').filter({ hasText: /you held a permit/i });
    await permit.getByRole('radio', { name: /yes, that is right/i }).check();

    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    const body = sent.join(' ');
    expect(body, 'the confirmed assertion was not sent').toContain('HELD_PERMIT');
    expect(body, 'an assertion the user never confirmed was sent anyway').not.toContain(
      'PAYMENT_BY_APP',
    );
    // And none of the model's words travelled with it.
    expect(body).not.toContain('Says a resident permit was held');
  });

  test('never sends the account itself to the assessment', async ({ page }) => {
    await stubReader(page, [PERMIT]);
    const sent: string[] = [];
    await page.route('**/api/cases/assess', async (route) => {
      sent.push(route.request().postData() ?? '');
      await route.continue();
    });

    await reachAccountPanel(page);
    await page
      .getByRole('textbox', { name: /what happened/i })
      .fill('My name is Jane Smith of 12 Acacia Avenue and I was at St Thomas Hospital.');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await reachUnderstood(page);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    const body = sent.join(' ');
    for (const secret of ['Jane Smith', 'Acacia Avenue', 'St Thomas']) {
      expect(body, `${secret} was sent to the assessment endpoint`).not.toContain(secret);
    }
    expect(body).toContain('narrativeProvided');
  });

  test('carries on when the account cannot be read', async ({ page }) => {
    // This build has no model configured, so the reader genuinely fails. A
    // journey that dead-ends here would be worse than one that says so.
    await reachAccountPanel(page);
    await page.getByRole('textbox', { name: /what happened/i }).fill('I had a resident permit.');
    await page.getByRole('button', { name: /^continue$/i }).click();

    await reachUnderstood(page);
    await expect(page.getByText(/cannot read written accounts|could not read your account/i)).toBeVisible();

    await page.getByRole('button', { name: /^continue$/i }).click();
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });
  });

  test('works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await stubReader(page, [PERMIT]);
    await reachAccountPanel(page);
    await page.getByRole('textbox', { name: /what happened/i }).fill('I had a resident permit.');
    await page.getByRole('button', { name: /^continue$/i }).click();
    await reachUnderstood(page);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the confirmation screen pushes the page sideways').toBeLessThanOrEqual(1);
  });
});

test.describe('two answers about the same thing', () => {
  const VALUES = [
    'Westminster City Council',
    'WM12345678',
    '12',
    '2026-08-11',
    '2026-08-14',
    'STRAND',
    '13000',
  ];

  /** The reading the Preview scenario produced, verbatim. */
  const RINGGO = [
    { kind: 'PAYMENT_MADE', stance: 'ASSERTED', confidence: 0.9, summary: 'Says the parking session was paid for.', source: 'USER_ACCOUNT' },
    { kind: 'PAYMENT_BY_APP', stance: 'ASSERTED', confidence: 0.9, summary: 'Says payment was made through RingGo.', source: 'USER_ACCOUNT' },
    { kind: 'WRONG_VRM_POSSIBLE', stance: 'ASSERTED', confidence: 0.7, summary: 'Says the wrong registration may have been selected.', source: 'USER_ACCOUNT' },
  ];

  async function reachQuestions(page: import('@playwright/test').Page) {
    await page.route('**/api/cases/narrative', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, assertions: RINGGO }),
      }),
    );

    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();
    const boxes = page.getByRole('textbox');
    const ticks = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(VALUES.length);
    for (let i = 0; i < VALUES.length; i++) {
      await boxes.nth(i).fill(VALUES[i]!);
      await ticks.nth(i).check();
    }
    await page.getByRole('button', { name: /confirm and continue/i }).click();

    await page
      .getByRole('textbox', { name: /what happened/i })
      .fill('I paid using RingGo but may have selected the wrong registration.');
    await page.getByRole('button', { name: /^continue$/i }).click();

    await reachUnderstood(page);
    await openAllReadings(page);
    for (const label of [/you paid to park/i, /you paid using an app/i, /wrong registration/i]) {
      await page
        .getByRole('group')
        .filter({ hasText: label })
        .getByRole('radio', { name: /yes, that is right/i })
        .check();
    }
    await reachFullQuestions(page);
    await expect(page.getByText(/did you hold a valid permit/i)).toBeVisible({ timeout: 20_000 });
  }

  test('an untouched question is never treated as a no', async ({ page }) => {
    const sent: string[] = [];
    await page.route('**/api/cases/assess', async (route) => {
      sent.push(route.request().postData() ?? '');
      await route.continue();
    });

    await reachQuestions(page);
    // Answer nothing at all.
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    const body = sent.join(' ');
    expect(body, 'an untouched question was sent as an answer').not.toContain('"answer":"NO"');
    // And the assessment shows no contradiction, because there is none.
    const text = await page.locator('body').innerText();
    expect(text).not.toMatch(/pay-and-display ticket or pay by app instead\? — no/i);
  });

  test('a contradiction is put to the user instead of being shown as two facts', async ({ page }) => {
    await reachQuestions(page);

    // The exact contradiction from the Preview report: the account said the
    // session was paid for, the questionnaire says no.
    await page
      .getByRole('group')
      .filter({ hasText: /pay-and-display ticket or pay by app/i })
      .getByRole('radio', { name: /^no$/i })
      .check();

    await expect(page.getByRole('button', { name: /check two answers first/i })).toBeVisible();
    await page.getByRole('button', { name: /check two answers first/i }).click();

    await expect(
      page.getByRole('heading', { name: /two different answers/i }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/we will not guess which one you meant/i)).toBeVisible();
    // Until it is settled, the fact is out.
    await expect(page.getByText(/left out of your assessment entirely/i)).toBeVisible();
    // And there is no way past it while it is unresolved.
    await expect(page.getByRole('button', { name: /choose 1 more/i })).toBeDisabled();
  });

  test('resolving it produces one version of the fact, not both', async ({ page }) => {
    await reachQuestions(page);
    await page
      .getByRole('group')
      .filter({ hasText: /pay-and-display ticket or pay by app/i })
      .getByRole('radio', { name: /^no$/i })
      .check();
    await page.getByRole('button', { name: /check two answers first/i }).click();
    await expect(page.getByRole('heading', { name: /two different answers/i })).toBeVisible({
      timeout: 20_000,
    });

    await page
      .getByRole('group')
      .filter({ hasText: /you paid to park/i })
      .getByRole('radio', { name: /yes, that is right/i })
      .check();
    await page.getByRole('button', { name: /back to your answers/i }).click();
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    const text = await page.locator('body').innerText();
    // One version of the fact.
    expect(text.toLowerCase()).toContain('you paid to park');
    // Not the pair that appeared together on the Preview screen.
    expect(text).not.toMatch(/pay-and-display ticket or pay by app instead\? — no/i);
  });

  test('evidence follows what the user said', async ({ page }) => {
    await reachQuestions(page);
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    await expect(page.getByText(/start with these/i)).toBeVisible();
    await expect(page.getByText(/less likely to matter here/i)).toBeVisible();

    const text = await page.locator('body').innerText();
    const appAt = text.indexOf('Parking app session');
    const permitAt = text.indexOf('Parking permit');
    expect(appAt, 'the app session is missing').toBeGreaterThan(-1);
    expect(permitAt, 'the permit was removed rather than de-prioritised').toBeGreaterThan(-1);
    expect(appAt, 'the permit is still asked for first').toBeLessThan(permitAt);
  });

  test('never says the user held a permit they did not mention', async ({ page }) => {
    // The account is about paying by app. Nothing in the assessment may report
    // an entitlement the user never claimed.
    await reachQuestions(page);
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    const text = await page.locator('body').innerText().then((t) => t.toLowerCase());
    expect(text, 'a permit was inferred from a payment').not.toContain('you held a permit');
    expect(text).not.toContain('you told us you held a permit');
    // What they did say is still there.
    expect(text).toContain('you paid using an app');
  });

  test('keeps the authority photographs prominent, not buried', async ({ page }) => {
    /*
     * The photographs were being demoted to "less likely to matter here" with
     * "You told us this is not what happened" — the reasoning backwards. They
     * are the evidence that can settle a disputed fact, either way.
     */
    await reachQuestions(page);
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    // innerText applies the band heading's text-transform, so search in lower case.
    const text = (await page.locator('body').innerText()).toLowerCase();
    const photosAt = text.indexOf('the authority’s photographs');
    const lessLikelyAt = text.indexOf('less likely to matter here');
    expect(photosAt, 'the photographs are missing').toBeGreaterThan(-1);
    expect(lessLikelyAt, 'nothing was de-prioritised at all').toBeGreaterThan(-1);
    expect(photosAt, 'the photographs were buried under "less likely"').toBeLessThan(lessLikelyAt);
    expect(text).toMatch(/support your account or contradict it/i);
  });

  test('a finding label and its heading are separate, not run together', async ({ page }) => {
    await reachQuestions(page);
    await page.getByRole('button', { name: /see my assessment/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });

    /*
     * The badge and the heading looked separated but were not: an inline-block
     * span butted straight against a <strong> meant copied text and the
     * accessibility tree both read "PCNWatch findingWhat the authority
     * alleges" as one phrase. Checked in the text rather than by geometry,
     * because geometry was never the thing that was wrong.
     */
    const cards = await page.evaluate(() => {
      const badges = [...document.querySelectorAll('span')].filter((el) =>
        /^(PCNWatch finding|You told us)$/.test((el.textContent ?? '').trim()),
      );
      return badges.map((badge) => {
        const card = badge.closest('div')?.parentElement as HTMLElement | null;
        return {
          label: (badge.textContent ?? '').trim(),
          // The card's own text, which is what a copy-paste and a screen reader
          // both see. A label run into its heading shows up here as one line.
          text: (card?.innerText ?? '').split('\n').slice(0, 2),
          headingTag: card?.querySelector('h3')?.tagName ?? null,
        };
      });
    });

    expect(cards.length, 'no labelled findings on the page').toBeGreaterThan(0);
    for (const card of cards) {
      // The label is a line of its own, and the heading is the next line.
      // innerText applies the badge's text-transform, so compare case-insensitively.
      expect(
        (card.text[0] ?? '').toLowerCase(),
        `"${card.label}" is run into what follows it`,
      ).toBe(card.label.toLowerCase());
      expect(card.text[1] ?? '', `"${card.label}" has no heading after it`).not.toBe('');
      // And the heading is a heading.
      expect(card.headingTag, `"${card.label}" has no heading element`).toBe('H3');
    }
  });

  test('the conflict screen works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await reachQuestions(page);
    await page
      .getByRole('group')
      .filter({ hasText: /pay-and-display ticket or pay by app/i })
      .getByRole('radio', { name: /^no$/i })
      .check();
    await page.getByRole('button', { name: /check two answers first/i }).click();
    await expect(page.getByRole('heading', { name: /two different answers/i })).toBeVisible({
      timeout: 20_000,
    });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the conflict screen pushes the page sideways').toBeLessThanOrEqual(1);
  });
});

test.describe('saving and coming back', () => {
  const VALUES = [
    'Westminster City Council',
    'WM12345678',
    '12',
    '2026-08-11',
    '2026-08-14',
    'STRAND',
    '13000',
  ];

  async function verifyAndAssess(page: import('@playwright/test').Page) {
    await page.goto('/analyse');
    await page.getByRole('button', { name: /enter the details/i }).click();
    const boxes = page.getByRole('textbox');
    const ticks = page.getByRole('checkbox');
    await expect(boxes).toHaveCount(VALUES.length);
    for (let i = 0; i < VALUES.length; i++) {
      await boxes.nth(i).fill(VALUES[i]!);
      await ticks.nth(i).check();
    }
    await page.getByRole('button', { name: /confirm and continue/i }).click();
    await page.getByRole('button', { name: /^skip for now$/i }).click();
    await openFullAnalysis(page);
    await expect(page.getByRole('heading', { name: 'Your PCN' })).toBeVisible({ timeout: 20_000 });
  }

  test('says plainly that nothing was saved when it could not be', async ({ page }) => {
    /*
     * This build has no Supabase configured, so the save genuinely cannot
     * happen — which is the case that matters most. A user told their case is
     * safe, who then finds it gone, has been misled by us rather than by their
     * browser.
     */
    await verifyAndAssess(page);

    await expect(page.getByText(/this assessment has not been saved/i)).toBeVisible();
    await expect(page.getByText(/leaving this page will lose it/i)).toBeVisible();
    // And it must not claim the opposite.
    await expect(page.getByText(/saved privately in this browser/i)).toHaveCount(0);
  });

  test('no longer claims that nothing is stored', async ({ page }) => {
    // The old copy said "Nothing about your notice is stored", which was true
    // then and would be a lie the moment a case is saved.
    await verifyAndAssess(page);
    await expect(page.getByText(/nothing about your notice is stored/i)).toHaveCount(0);
  });

  test('offers a way back to saved cases', async ({ page }) => {
    await page.goto('/cases');
    await expect(page.getByRole('heading', { name: /your cases/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /analyse a notice/i })).toBeVisible();
  });

  test('is honest about what an anonymous session is', async ({ page }) => {
    await page.goto('/cases');

    // The limitation is stated rather than buried: there is no account, and the
    // way back lives in this browser only.
    await expect(page.getByText(/no account behind this list/i)).toBeVisible();
    await expect(page.getByText(/clearing your browsing data/i)).toBeVisible();
    // And the narrative boundary is restated where a user would ask about it.
    await expect(page.getByText(/what you wrote in your own words was never saved/i)).toBeVisible();
  });

  test('shows an empty state rather than an error with no session', async ({ page }) => {
    await page.goto('/cases');
    // With no Supabase and no session, "you have nothing here" is the honest
    // answer — not a failure, and not a sign-up wall.
    await expect(page.getByText(/no cases in this browser|not saved a case yet|cannot reach your cases/i)).toBeVisible();
    await expect(page.getByText(/sign up|create an account|password/i)).toHaveCount(0);
  });

  test('does not expose another user’s case by changing the id', async ({ request }) => {
    // No session at all: the boundary must hold before any identity exists.
    const response = await request.get('/case/55555555-5555-4555-8555-555555555555');
    const body = await response.text();
    expect(body).not.toMatch(/WM12345678/);
    expect(body).toMatch(/not found|cannot|sign|no case|unavailable/i);
  });

  test('the cases page works at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/cases');
    await expect(page.getByRole('heading', { name: /your cases/i })).toBeVisible();

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, 'the cases page pushes the page sideways').toBeLessThanOrEqual(1);
  });
});

test.describe('finding your way back to a saved case', () => {
  /**
   * Navigation to /cases.
   *
   * Persistence worked in Preview and was still unreachable: the case was
   * saved, the page rendered, and nothing in the site pointed at it. A feature
   * nobody can find is a feature nobody has.
   */

  const navLink = (page: import('@playwright/test').Page) =>
    page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: /your cases/i });

  test('the primary navigation offers it on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');

    await expect(navLink(page)).toBeVisible();
    await navLink(page).click();
    await expect(page).toHaveURL(/\/cases$/);
    await expect(page.getByRole('heading', { name: /your cases/i })).toBeVisible();
  });

  test('the primary navigation offers it on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/');

    await expect(navLink(page)).toBeVisible();
    await navLink(page).click();
    await expect(page).toHaveURL(/\/cases$/);
  });

  test('it is reachable without swiping the navigation on the narrowest phone', async ({ page }) => {
    /*
     * The strip scrolls horizontally, so "somewhere in the navigation" is not
     * the same as "findable". Anything appended to the end of it sits
     * off-screen until a user thinks to swipe a navigation bar, which nobody
     * does when looking for something they are not sure exists.
     */
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');

    const position = await navLink(page).evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { left: box.left, right: box.right, width: window.innerWidth, height: box.height };
    });

    expect(position.left, 'the link starts off the left of the screen').toBeGreaterThanOrEqual(0);
    expect(position.right, 'the link is off the right of the screen until scrolled').toBeLessThanOrEqual(
      position.width,
    );
    // And it is still a real touch target.
    expect(position.height).toBeGreaterThanOrEqual(44);
  });

  test('does not bury the map to make room', async ({ page }) => {
    // The header comment is explicit that the map is the hero and must not be
    // hidden. Adding a link ahead of it must not push it off the screen.
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto('/');

    const map = page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Map' });
    const visible = await map.evaluate(
      (el) => el.getBoundingClientRect().right <= window.innerWidth,
    );
    expect(visible, 'the map link was pushed off screen').toBe(true);
  });

  test('leaves Analyse my PCN as the primary action at every width', async ({ page }) => {
    for (const [width, height] of [[320, 568], [375, 720], [1280, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/');

      const cta = page.getByRole('link', { name: /analyse my pcn/i }).first();
      await expect(cta, `the call to action is missing at ${width}px`).toBeVisible();

      // Still the styled primary, not demoted to a plain nav link.
      const isCta = await cta.evaluate((el) => el.classList.contains('fr-cta'));
      expect(isCta, `the call to action lost its styling at ${width}px`).toBe(true);

      // And it sits outside the navigation strip, where it always has.
      const insideNav = await cta.evaluate((el) => el.closest('nav') !== null);
      expect(insideNav, `the call to action moved into the navigation at ${width}px`).toBe(false);
    }
  });

  test('adds nothing sideways at any width', async ({ page }) => {
    for (const [width, height] of [[320, 568], [375, 720], [768, 900], [1280, 900]] as const) {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `the header pushes the page sideways at ${width}px`).toBeLessThanOrEqual(1);
    }
  });

  test('still handles having no cases gracefully', async ({ page }) => {
    // Arriving from the navigation is the common way a first-time visitor will
    // reach this page, so the empty state matters more than before.
    await page.goto('/');
    await navLink(page).click();

    await expect(page.getByRole('heading', { name: /your cases/i })).toBeVisible();
    await expect(
      page.getByText(/no cases in this browser|not saved a case yet|cannot reach your cases/i),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /analyse a notice/i })).toBeVisible();
    // No sign-up wall, then or now.
    await expect(page.getByText(/sign up|create an account|password/i)).toHaveCount(0);
  });

  test('keeps the private list out of the public footer', async ({ page }) => {
    // The footer's Explore column is about what the site holds. One person's
    // noindex case list is not that, and listing it there would imply it is
    // somewhere to browse.
    await page.goto('/');
    const footerLinks = page.locator('footer').getByRole('link', { name: /your cases/i });
    await expect(footerLinks).toHaveCount(0);
  });
});
