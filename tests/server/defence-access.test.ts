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

beforeEach(() => {
  state.flag = 'off';
  state.entitled = false;
  setNodeEnv('test');
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

  it('still honours a real purchase in production', async () => {
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
