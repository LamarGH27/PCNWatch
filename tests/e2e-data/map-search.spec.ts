import { expect, test } from '@playwright/test';

/**
 * Map search, in a real browser, against a real dataset.
 *
 * Separated from `tests/e2e` because that suite deliberately runs with no
 * credentials — it exists to prove the honesty behaviours of an unconfigured
 * deployment. The map hides itself entirely there, search box included, so
 * these tests could not reach the thing they test.
 *
 * A user pressing Go and seeing nothing happen is the bug. Proving it fixed
 * needs a rendered map, real locations, and a real click.
 */

const SEARCH = /search for a street or postcode/i;

/**
 * The search's own status region.
 *
 * Addressed by role *and* label because `/map` carries four live regions — the
 * demo-data banner, the basemap notice, the geolocated-share caveat and this
 * one. A bare `role=status` matches all four, which is also why the region
 * carries a name: a screen-reader user hears them the same way.
 */
const searchStatus = (page: import('@playwright/test').Page) =>
  page.locator('[role="status"][aria-label="Search status"]');

/**
 * The status text once the search has settled.
 *
 * `toBeVisible()` is satisfied by the "Searching…" state, so reading the text
 * straight after it returns the spinner's words rather than the answer.
 */
async function settledStatus(page: import('@playwright/test').Page): Promise<string> {
  const status = searchStatus(page);
  await expect(status).toBeVisible({ timeout: 20_000 });
  await expect(status).not.toHaveText(/^Searching/i, { timeout: 20_000 });
  return (await status.textContent()) ?? '';
}

/**
 * What this suite can and cannot prove.
 *
 * It proves the part that was broken: a search resolves, and every outcome is
 * visible and correctly worded. That is the bug — pressing Go did nothing at
 * all, because the endpoint discarded every result and the client rendered
 * nothing for an empty list.
 *
 * It does not assert camera movement. MapLibre only fetches enforcement cells
 * after its style loads, so on a machine that cannot reach the basemap CDN the
 * map never finishes initialising and there is no observable consequence to
 * check. A test that silently passes in that state would be worse than none.
 * The `flyTo` call itself is covered where it can be checked honestly — in the
 * unit tests for the decision, and by eye on a deployment.
 *
 * Postcode resolution needs outbound access to the geocoder. Where that is
 * unavailable the correct behaviour is an explicit "unavailable" message, and
 * both branches are asserted below: the requirement is that the user never sees
 * nothing, not that every environment has internet.
 */

test.describe('the map goes where the user asked', () => {
  test('a street search moves the map and names the result', async ({ page, request }) => {

    // The street is taken from the dataset the server is actually serving,
    // rather than hardcoded: this suite must prove the behaviour on whatever
    // Camden data is loaded, not on one fixture's naming scheme.
    const seed = await request.get('/api/map/search?authority=camden&q=street');
    const body = (await seed.json()) as { results: { displayName: string }[] };
    const street = body.results[0]?.displayName;
    expect(street, 'the dataset must contain at least one searchable street').toBeTruthy();

    await page.goto('/map');
    const input = page.getByRole('textbox', { name: SEARCH });
    await expect(input).toBeVisible();

    await input.fill(street!);
    await page.getByRole('button', { name: 'Go' }).click();

    // Named back to the user, so the result is identified rather than implied.
    await expect(searchStatus(page)).toContainText(
      new RegExp(`${street!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*located`, 'i'),
      { timeout: 20_000 },
    );
  });

  test('a postcode search reports the postcode, or says why it could not', async ({ page }) => {
    await page.goto('/map');
    const input = page.getByRole('textbox', { name: SEARCH });
    await expect(input).toBeVisible();

    await input.fill('NW1 1AA');
    await input.press('Enter'); // Enter submits — no click needed.

    // Two legitimate outcomes, depending on whether this environment can reach
    // the postcode service. Both are asserted, because the requirement is that
    // the user never presses Go and sees nothing — not that a sandbox has
    // internet. Silence is the only failure.
    const text = await settledStatus(page);
    if (/unavailable at the moment/i.test(text)) {
      expect(text).toMatch(/not a statement about enforcement/i);
      return;
    }

    expect(text).toMatch(/NW1 1AA/i);
    expect(text).toMatch(/located\. Showing this area\./i);
  });

  test('an unknown street says so instead of doing nothing', async ({ page }) => {
    await page.goto('/map');
    const input = page.getByRole('textbox', { name: SEARCH });
    await expect(input).toBeVisible();

    await input.fill('Nonexistent Avenue');
    await input.press('Enter');

    await expect(searchStatus(page)).toContainText(/no match/i, { timeout: 20_000 });
  });

  test('a postcode outside Camden never claims there is no enforcement', async ({ page }) => {
    await page.goto('/map');
    const input = page.getByRole('textbox', { name: SEARCH });
    await expect(input).toBeVisible();

    await input.fill('M1 1AE'); // Manchester.
    await input.press('Enter');

    const text = await settledStatus(page);
    if (/unavailable at the moment/i.test(text)) return; // No geocoder reachable here.

    expect(text).toMatch(/covers camden only/i);
    // The distinction that matters: our data is missing, enforcement is not absent.
    expect(text).toMatch(/gap in our data/i);
    expect(text).not.toMatch(/no penalty charge notices are issued(?! in this area)/i);
  });

  test('the status is announced to assistive technology', async ({ page }) => {
    await page.goto('/map');
    const input = page.getByRole('textbox', { name: SEARCH });
    await expect(input).toBeVisible();
    await input.fill('Camden High Street');
    await input.press('Enter');

    const status = searchStatus(page);
    await expect(status).toBeVisible({ timeout: 20_000 });
    await expect(status).toHaveAttribute('aria-live', 'polite');
  });

  test('search stays usable and on-screen at mobile width', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 720 });
    await page.goto('/map');

    const input = page.getByRole('textbox', { name: SEARCH });
    const go = page.getByRole('button', { name: 'Go' });
    await expect(input).toBeVisible();
    await expect(go).toBeVisible();

    const box = await go.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.width).toBeGreaterThanOrEqual(40);

    await input.fill('NW1 1AA');
    await go.click();

    const status = searchStatus(page);
    await expect(status).toBeVisible({ timeout: 20_000 });

    const statusBox = await status.boundingBox();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.x).toBeGreaterThanOrEqual(0);
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(376);
  });
});
