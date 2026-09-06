import { expect, test } from '@playwright/test';

/**
 * Critical browser flows.
 *
 * These run against a build with no credentials, which is the point: the
 * behaviours most worth proving in a real browser are the ones about honesty and
 * privacy, and a fully-configured environment would hide them.
 */

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
      '/case/00000000-0000-0000-0000-000000000001/draft?checkout=returned&paid=true&session_id=cs_test_forged',
    );
    // No draft, no entitlement, regardless of what the URL claims.
    await expect(page.getByRole('heading', { name: 'Ready to draft' })).toHaveCount(0);
    await expect(page.getByText(/Continue to payment/)).toHaveCount(0);
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
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Straight from the approved reference record for code 12.
    await expect(page.getByText(/did you hold a valid permit for that bay/i)).toBeVisible();
    await expect(page.getByText(/pay-and-display ticket or pay by app/i)).toBeVisible();

    // And the warning that a yes is not a defence.
    await expect(page.getByText(/does not mean you have a defence/i)).toBeVisible();
  });

  test('marks mitigation as discretion rather than a legal ground', async ({ page }) => {
    await reachContextStage(page);
    await page.getByRole('button', { name: /^continue$/i }).click();
    await expect(page.getByText(/it is not a legal ground/i)).toBeVisible();
  });

  test('an answered case reaches an assessment that uses the answers', async ({ page }) => {
    await reachContextStage(page);
    await page
      .getByRole('textbox', { name: /what happened/i })
      .fill('I had a resident permit for that bay and had renewed it that morning.');
    await page.getByRole('button', { name: /^continue$/i }).click();

    // Answer the permit question yes.
    const permit = page.getByRole('group').filter({ hasText: /did you hold a valid permit/i });
    await permit.getByRole('radio', { name: /^yes$/i }).check();

    // Declare the permit, behind the disclosure.
    await page.getByRole('button', { name: /anything that supports this/i }).click();
    const permitEvidence = page.getByRole('group').filter({ hasText: /parking permit/i });
    await permitEvidence.getByRole('radio', { name: /i have this/i }).check();

    await page.getByRole('button', { name: /see my assessment/i }).click();
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
    await page.getByRole('button', { name: /^continue$/i }).click();

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
