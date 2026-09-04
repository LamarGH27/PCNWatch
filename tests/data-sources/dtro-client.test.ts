import { describe, expect, it, vi } from 'vitest';
import {
  DTroClient,
  DTroNotConfiguredError,
  DTroRequestError,
  unmeasuredCoverage,
} from '@/data-sources/dtro/client';

const CONFIG = {
  clientId: 'test-client',
  clientSecret: 'test-secret',
  baseUrl: 'https://dtro.example.test',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('D-TRO client — configuration boundary', () => {
  it('refuses every call when credentials are absent', async () => {
    const client = new DTroClient({});
    expect(client.isConfigured).toBe(false);
    expect(client.missingConfiguration()).toEqual([
      'DTRO_CLIENT_ID',
      'DTRO_CLIENT_SECRET',
      'DTRO_BASE_URL',
    ]);
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(DTroNotConfiguredError);
    await expect(client.search()).rejects.toBeInstanceOf(DTroNotConfiguredError);
  });

  it('names exactly which settings are missing', async () => {
    const client = new DTroClient({ clientId: 'x', baseUrl: 'https://example.test' });
    expect(client.missingConfiguration()).toEqual(['DTRO_CLIENT_SECRET']);
  });

  it('never returns sample data as a fallback', async () => {
    const client = new DTroClient({});
    await expect(client.search()).rejects.toThrow(/none will be invented/);
  });

  it('reports coverage as unavailable until it has been measured', () => {
    const coverage = unmeasuredCoverage('camden');
    expect(coverage.status).toBe('UNAVAILABLE');
    expect(coverage.recordsFound).toBe(0);
    expect(coverage.measuredAt).toBeNull();
  });
});

describe('D-TRO client — OAuth', () => {
  it('retrieves and caches a token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ access_token: 'token-1', expires_in: 3600 }));
    const client = new DTroClient({ ...CONFIG, fetchImpl: fetchImpl as unknown as typeof fetch });

    expect(await client.getAccessToken()).toBe('token-1');
    expect(await client.getAccessToken()).toBe('token-1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('re-authenticates once the cached token is close to expiry', async () => {
    let now = 1_000_000;
    let issued = 0;
    const fetchImpl = vi.fn(async () => {
      issued += 1;
      return jsonResponse({ access_token: `token-${issued}`, expires_in: 120 });
    });
    const client = new DTroClient({
      ...CONFIG,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => now,
    });

    expect(await client.getAccessToken()).toBe('token-1');
    // 61s in: inside the 60s expiry skew, so the token is treated as spent.
    now += 61_000;
    expect(await client.getAccessToken()).toBe('token-2');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('shares one token request between concurrent callers', async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
    });
    const client = new DTroClient({ ...CONFIG, fetchImpl: fetchImpl as unknown as typeof fetch });

    const tokens = await Promise.all([
      client.getAccessToken(),
      client.getAccessToken(),
      client.getAccessToken(),
    ]);
    expect(tokens).toEqual(['token-1', 'token-1', 'token-1']);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a token endpoint failure rather than continuing unauthenticated', async () => {
    const client = new DTroClient({
      ...CONFIG,
      fetchImpl: (async () => new Response('denied', { status: 401 })) as unknown as typeof fetch,
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(DTroRequestError);
  });

  it('rejects a token response that does not match the expected shape', async () => {
    const client = new DTroClient({
      ...CONFIG,
      fetchImpl: (async () => jsonResponse({ nope: true })) as unknown as typeof fetch,
    });
    await expect(client.getAccessToken()).rejects.toThrow(/expected shape/);
  });
});

describe('D-TRO client — search', () => {
  function searchClient(handler: (url: string, init?: RequestInit) => Promise<Response>) {
    return new DTroClient({
      ...CONFIG,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        if (String(url).includes('/oauth/token')) {
          return jsonResponse({ access_token: 'token-1', expires_in: 3600 });
        }
        return handler(String(url), init);
      }) as unknown as typeof fetch,
    });
  }

  it('returns a page of records with pagination metadata', async () => {
    const client = searchClient(async () =>
      jsonResponse({ records: [{ id: 'a' }, { id: 'b' }], totalRecords: 5 }),
    );
    const page = await client.search({ pageSize: 2 });
    expect(page.records).toHaveLength(2);
    expect(page.totalRecords).toBe(5);
    expect(page.hasMore).toBe(true);
  });

  it('walks every page and stops', async () => {
    let call = 0;
    const client = searchClient(async () => {
      call += 1;
      return call < 3
        ? jsonResponse({ records: [{ id: call }, { id: call }], totalRecords: 6 })
        : jsonResponse({ records: [{ id: call }, { id: call }], totalRecords: 6 });
    });
    const collected: unknown[] = [];
    for await (const record of client.searchAll({ pageSize: 2 })) collected.push(record);
    expect(collected).toHaveLength(6);
  });

  it('retries exactly once after a 401 with a refreshed token', async () => {
    let searchCalls = 0;
    const client = searchClient(async () => {
      searchCalls += 1;
      return searchCalls === 1
        ? new Response('expired', { status: 401 })
        : jsonResponse({ records: [{ id: 'ok' }], totalRecords: 1 });
    });
    const page = await client.search();
    expect(page.records).toHaveLength(1);
    expect(searchCalls).toBe(2);
  });

  it('marks a rate limit as retryable', async () => {
    const client = searchClient(async () => new Response('slow down', { status: 429 }));
    await expect(client.search()).rejects.toMatchObject({ status: 429, retryable: true });
  });

  it('marks a client error as not retryable', async () => {
    const client = searchClient(async () => new Response('bad request', { status: 400 }));
    await expect(client.search()).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it('rejects an unexpected payload shape rather than yielding nothing quietly', async () => {
    const client = searchClient(async () => jsonResponse({ unexpected: true }));
    await expect(client.search()).rejects.toThrow(/unexpected payload/);
  });

  it('caps page size so a caller cannot request an unbounded page', async () => {
    let sentPageSize: number | undefined;
    const client = searchClient(async (_url, init) => {
      sentPageSize = JSON.parse(String(init?.body)).pageSize;
      return jsonResponse({ records: [], totalRecords: 0 });
    });
    await client.search({ pageSize: 10_000 });
    expect(sentPageSize).toBe(200);
  });
});
