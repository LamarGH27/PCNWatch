import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Who may have a Defence Pack, and how it does not become permanently free.
 *
 * The specific accident this guards against: a preview flag copied from the
 * Preview environment to Production, and the premium product is given away with
 * nobody noticing until somebody looks at revenue. So the flag is refused in a
 * production build regardless of its value — two things have to be wrong at
 * once, and one of them is not an environment variable anyone can copy.
 */

const state = { flag: 'off' as 'on' | 'off', entitled: false };

vi.mock('@/lib/env', () => ({
  get featureFlags() {
    return { dtro: false, payments: false, defencePackPreview: state.flag === 'on' };
  },
}));

vi.mock('@/server/payments/entitlements', () => ({
  requireEntitlement: async () => ({
    granted: state.entitled,
    entitlement: 'CHALLENGE_DRAFT',
    reason: 'This part of your case requires the Defence Pack, which has not been purchased yet.',
  }),
}));

import { defencePackAccess, previewAccessAvailable } from '@/server/defence/access';

const CASE = '11111111-1111-4111-8111-111111111111';
const USER = 'aaaaaaaa-0000-4000-8000-00000000000a';

/*
 * `NODE_ENV` is read at call time rather than at module load precisely so this
 * is testable — the production branch is the one that matters and a constant
 * captured at import would make it unreachable from here.
 */
function setNodeEnv(value: string) {
  vi.stubEnv('NODE_ENV', value);
}

/**
 * The deployment, as Vercel reports it.
 *
 * `undefined` means off Vercel — local development or this suite — which is the
 * only place the NODE_ENV fallback is ever consulted.
 */
function setVercelEnv(value: string | undefined) {
  vi.stubEnv('VERCEL_ENV', value === undefined ? '' : value);
}

beforeEach(() => {
  state.flag = 'off';
  state.entitled = false;
  setNodeEnv('test');
  setVercelEnv(undefined);
});

afterEach(() => vi.unstubAllEnvs());

describe('the paid boundary', () => {
  it('refuses a user with no entitlement and no flag', async () => {
    const access = await defencePackAccess(USER, CASE);
    expect(access.granted).toBe(false);
  });

  it('refuses a caller with no session, whatever the flag says', async () => {
    state.flag = 'on';
    const access = await defencePackAccess(undefined, CASE);
    expect(access.granted).toBe(false);
    expect(access.granted === false && access.reason).toMatch(/signed in/i);
  });

  it('grants a purchased entitlement', async () => {
    state.entitled = true;
    const access = await defencePackAccess(USER, CASE);
    expect(access.granted && access.via).toBe('ENTITLEMENT');
  });

  it('grants the preview flag outside production', async () => {
    state.flag = 'on';
    const access = await defencePackAccess(USER, CASE);
    expect(access.granted && access.via).toBe('PREVIEW_FLAG');
  });

  it('refuses the preview flag in a production build', async () => {
    // The accident this exists for: the variable copied to Production.
    state.flag = 'on';
    setNodeEnv('production');

    expect(previewAccessAvailable()).toBe(false);
    const access = await defencePackAccess(USER, CASE);
    expect(access.granted).toBe(false);
  });
});

/**
 * On Vercel, where the original check was wrong.
 *
 * `NODE_ENV` is `production` for Preview and Production alike — Vercel builds
 * both with `next build` — so the first version of this gate was statically
 * false on Preview and webpack dropped the branch from the bundle entirely.
 * Setting the flag did nothing, and no test noticed because they all stubbed
 * `NODE_ENV` to a value Vercel never uses.
 *
 * Every test below therefore sets `NODE_ENV` to production, as Vercel does, so
 * that a regression to the old logic fails rather than passing on a value that
 * only occurs in this file.
 */
describe('the paid boundary on Vercel', () => {
  beforeEach(() => setNodeEnv('production'));

  it('grants preview access on a Preview deployment with the flag on', async () => {
    setVercelEnv('preview');
    state.flag = 'on';

    expect(previewAccessAvailable()).toBe(true);
    const access = await defencePackAccess(USER, CASE);
    expect(access.granted && access.via).toBe('PREVIEW_FLAG');
  });

  it('refuses preview access on a Preview deployment with the flag off', async () => {
    setVercelEnv('preview');
    state.flag = 'off';

    expect(previewAccessAvailable()).toBe(false);
    expect((await defencePackAccess(USER, CASE)).granted).toBe(false);
  });

  it('refuses preview access on Production even with the flag set to on', async () => {
    /*
     * The accident the whole gate exists for: the variable copied from the
     * Preview environment to Production. Two things have to be wrong at once,
     * and one of them is not an environment variable anybody can copy.
     */
    setVercelEnv('production');
    state.flag = 'on';

    expect(previewAccessAvailable()).toBe(false);
    expect((await defencePackAccess(USER, CASE)).granted).toBe(false);
  });

  it('still honours a real purchase on Production', async () => {
    // Closing the preview door must not close the paid one.
    setVercelEnv('production');
    state.flag = 'off';
    state.entitled = true;

    const access = await defencePackAccess(USER, CASE);
    expect(access.granted && access.via).toBe('ENTITLEMENT');
  });

  it('does not open the door to a deployment kind Vercel has not invented yet', async () => {
    /*
     * The reason the Vercel branch asks for `preview` rather than
     * `!== 'production'`. A future third value would satisfy "not production"
     * and quietly grant the paid product on it.
     */
    setVercelEnv('development');
    state.flag = 'on';
    expect(previewAccessAvailable()).toBe(false);

    setVercelEnv('some-future-environment');
    expect(previewAccessAvailable()).toBe(false);
  });

  it('falls back to NODE_ENV only when Vercel says nothing', async () => {
    // Off Vercel the old behaviour is correct and is kept: a dev server is not
    // production, and the flag works there as it always did.
    setVercelEnv(undefined);
    setNodeEnv('development');
    state.flag = 'on';

    expect(previewAccessAvailable()).toBe(true);
  });

  it('still honours a real purchase in a production build off Vercel', async () => {
    // Closing the preview door must not close the paid one.
    state.entitled = true;
    state.flag = 'off';
    setNodeEnv('production');

    const access = await defencePackAccess(USER, CASE);
    expect(access.granted && access.via).toBe('ENTITLEMENT');
  });

  it('is off unless the flag is explicitly on', async () => {
    for (const value of ['off', '', 'true', 'yes'] as const) {
      state.flag = value as 'on' | 'off';
      expect(await defencePackAccess(USER, CASE).then((a) => a.granted)).toBe(false);
    }
  });
});
