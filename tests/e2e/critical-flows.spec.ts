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
