import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The magic-link callback.
 *
 * It is the one route that turns an email into a session, which makes it the
 * one place where getting the destination wrong matters: a callback that
 * redirects wherever the query string says is an open redirect, and an open
 * redirect on a sign-in route is a credible phishing hop that borrows the real
 * domain to do it.
 */

const state = {
  exchanged: [] as string[],
  exchangeFails: false,
  clientAvailable: true,
};

vi.mock('@/lib/supabase/server', () => ({
  createSupabaseServerClient: async () =>
    state.clientAvailable
      ? {
          auth: {
            exchangeCodeForSession: async (code: string) => {
              state.exchanged.push(code);
              return state.exchangeFails ? { error: new Error('expired') } : { error: null };
            },
          },
        }
      : null,
}));

const { GET } = await import('@/app/admin/auth/callback/route');

const call = (query: string) =>
  GET(new Request(`https://pcnwatch.co.uk/admin/auth/callback${query}`));

beforeEach(() => {
  state.exchanged = [];
  state.exchangeFails = false;
  state.clientAvailable = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('magic-link callback', () => {
  it('exchanges the code and lands on the dashboard', async () => {
    const response = await call('?code=abc123');

    expect(state.exchanged).toEqual(['abc123']);
    expect(response.headers.get('location')).toBe('https://pcnwatch.co.uk/admin/analytics');
  });

  it('ignores a destination supplied in the query string', async () => {
    const response = await call(
      '?code=abc123&next=https%3A%2F%2Fevil.example%2Fsteal&redirect_to=%2Fwherever',
    );

    // The only destination this route has is a constant.
    expect(response.headers.get('location')).toBe('https://pcnwatch.co.uk/admin/analytics');
  });

  it('sends a request with no code back to the form', async () => {
    const response = await call('');

    expect(state.exchanged).toEqual([]);
    expect(response.headers.get('location')).toBe('https://pcnwatch.co.uk/admin/sign-in');
  });

  it('sends an expired or reused link back to the form', async () => {
    state.exchangeFails = true;

    const response = await call('?code=stale');

    expect(response.headers.get('location')).toBe('https://pcnwatch.co.uk/admin/sign-in');
  });

  it('refuses rather than crashing when Supabase is not configured', async () => {
    state.clientAvailable = false;

    const response = await call('?code=abc123');

    expect(response.headers.get('location')).toBe('https://pcnwatch.co.uk/admin/sign-in');
  });
});
