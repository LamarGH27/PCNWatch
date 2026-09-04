import { z } from 'zod';

/**
 * D-TRO (Digital Traffic Regulation Order) client.
 *
 * Status: built to the credential boundary and stopped there, deliberately.
 *
 * The service uses OAuth client-credentials. Without DTRO_CLIENT_ID,
 * DTRO_CLIENT_SECRET and DTRO_BASE_URL this client refuses every call with
 * `DTroNotConfiguredError`. It does not return sample data, and there is no
 * fallback path that could make an unconfigured deployment look like a working
 * one. The UI is additionally gated behind NEXT_PUBLIC_FLAG_DTRO.
 *
 * Two things must be true before this is exposed to users:
 *   1. Credentials exist and a proof-of-concept run has succeeded.
 *   2. Actual geographic coverage for the boroughs we show has been measured —
 *      not assumed from the API's existence.
 *
 * Legal framing: D-TRO is a digital representation of a traffic regulation order.
 * It is not the order itself. Anything derived from it must be labelled as such
 * wherever it is displayed (see dtro_restrictions in migration 0003).
 */

export class DTroNotConfiguredError extends Error {
  readonly code = 'DTRO_NOT_CONFIGURED';
  constructor(readonly missing: readonly string[]) {
    super(
      `D-TRO is not configured. Missing: ${missing.join(', ')}. ` +
        'No restriction data can be retrieved and none will be invented.',
    );
    this.name = 'DTroNotConfiguredError';
  }
}

export class DTroRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'DTroRequestError';
  }
}

export interface DTroConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly baseUrl?: string;
  /** Token endpoint. Defaults to `${baseUrl}/oauth/token`. */
  readonly tokenUrl?: string;
  readonly fetchImpl?: typeof fetch;
  /** Injected clock, in milliseconds since epoch. Tests supply their own. */
  readonly now?: () => number;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive().optional(),
});

/** Seconds of headroom so a token is never used in its final moments. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;

export interface DTroSearchParams {
  readonly page?: number;
  readonly pageSize?: number;
  /** GeoJSON geometry to search within, when the caller has one. */
  readonly geometry?: unknown;
  readonly traName?: string;
  readonly modifiedSince?: string;
}

export interface DTroSearchPage {
  readonly records: readonly unknown[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalRecords: number | null;
  readonly hasMore: boolean;
}

interface CachedToken {
  readonly value: string;
  /** Epoch milliseconds after which the token must not be used. */
  readonly expiresAtMs: number;
}

export class DTroClient {
  private token: CachedToken | null = null;
  private inFlightToken: Promise<string> | null = null;

  constructor(private readonly config: DTroConfig) {}

  /** Which required settings are absent. Empty means the client is usable. */
  missingConfiguration(): string[] {
    const missing: string[] = [];
    if (!this.config.clientId) missing.push('DTRO_CLIENT_ID');
    if (!this.config.clientSecret) missing.push('DTRO_CLIENT_SECRET');
    if (!this.config.baseUrl) missing.push('DTRO_BASE_URL');
    return missing;
  }

  get isConfigured(): boolean {
    return this.missingConfiguration().length === 0;
  }

  /**
   * Returns the credentials, or throws. Callers use the returned value rather
   * than re-reading `this.config`, so a missing setting cannot slip past.
   */
  private requireConfig(): { clientId: string; clientSecret: string; baseUrl: string } {
    const missing = this.missingConfiguration();
    if (missing.length > 0) throw new DTroNotConfiguredError(missing);
    return {
      clientId: this.config.clientId as string,
      clientSecret: this.config.clientSecret as string,
      baseUrl: this.config.baseUrl as string,
    };
  }

  private get fetchImpl(): typeof fetch {
    return this.config.fetchImpl ?? fetch;
  }

  private get now(): number {
    return (this.config.now ?? Date.now)();
  }

  /**
   * Returns a valid bearer token, reusing the cached one until it is close to
   * expiry. Concurrent callers share a single in-flight request rather than
   * each opening their own.
   */
  async getAccessToken(): Promise<string> {
    const credentials = this.requireConfig();

    if (this.token && this.token.expiresAtMs > this.now) return this.token.value;
    if (this.inFlightToken) return this.inFlightToken;

    const tokenUrl = this.config.tokenUrl ?? `${trimSlash(credentials.baseUrl)}/oauth/token`;

    this.inFlightToken = (async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      });

      let response: Response;
      try {
        response = await this.fetchImpl(tokenUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body,
        });
      } catch (cause) {
        throw new DTroRequestError(
          `Could not reach the D-TRO token endpoint: ${(cause as Error).message}`,
          null,
          true,
        );
      }

      if (!response.ok) {
        throw new DTroRequestError(
          `D-TRO token request failed with HTTP ${response.status}.`,
          response.status,
          response.status >= 500 || response.status === 429,
        );
      }

      const parsed = tokenResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new DTroRequestError('D-TRO token response did not match the expected shape.', null, false);
      }

      const lifetimeSeconds = Math.max(
        1,
        (parsed.data.expires_in ?? 3600) - TOKEN_EXPIRY_SKEW_SECONDS,
      );
      this.token = {
        value: parsed.data.access_token,
        expiresAtMs: this.now + lifetimeSeconds * 1000,
      };
      return this.token.value;
    })();

    try {
      return await this.inFlightToken;
    } finally {
      this.inFlightToken = null;
    }
  }

  /** Clears the cached token, forcing the next call to re-authenticate. */
  invalidateToken(): void {
    this.token = null;
  }

  /**
   * One page of search results.
   *
   * A 401 is retried exactly once with a fresh token, because a token can expire
   * between the check and the call. Anything else surfaces.
   */
  async search(params: DTroSearchParams = {}, attempt = 0): Promise<DTroSearchPage> {
    const credentials = this.requireConfig();

    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 50, 200);
    const token = await this.getAccessToken();
    const url = `${trimSlash(credentials.baseUrl)}/v1/search`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          page,
          pageSize,
          ...(params.geometry ? { geometry: params.geometry } : {}),
          ...(params.traName ? { traName: params.traName } : {}),
          ...(params.modifiedSince ? { modifiedSince: params.modifiedSince } : {}),
        }),
      });
    } catch (cause) {
      throw new DTroRequestError(
        `Could not reach the D-TRO search endpoint: ${(cause as Error).message}`,
        null,
        true,
      );
    }

    if (response.status === 401 && attempt === 0) {
      this.invalidateToken();
      return this.search(params, 1);
    }

    if (response.status === 429) {
      throw new DTroRequestError(
        'D-TRO rate limit reached. Back off and retry.',
        429,
        true,
      );
    }

    if (!response.ok) {
      throw new DTroRequestError(
        `D-TRO search failed with HTTP ${response.status}.`,
        response.status,
        response.status >= 500,
      );
    }

    const payload = (await response.json().catch(() => null)) as
      | { records?: unknown[]; totalRecords?: number }
      | unknown[]
      | null;

    if (Array.isArray(payload)) {
      return { records: payload, page, pageSize, totalRecords: null, hasMore: payload.length >= pageSize };
    }
    if (!payload || !Array.isArray(payload.records)) {
      throw new DTroRequestError('D-TRO search returned an unexpected payload shape.', null, false);
    }

    const records = payload.records;
    const totalRecords = typeof payload.totalRecords === 'number' ? payload.totalRecords : null;
    return {
      records,
      page,
      pageSize,
      totalRecords,
      hasMore: totalRecords === null ? records.length >= pageSize : page * pageSize < totalRecords,
    };
  }

  /** Walks every page. `maxPages` bounds the walk so a bad `hasMore` cannot loop. */
  async *searchAll(params: DTroSearchParams = {}, maxPages = 100): AsyncGenerator<unknown> {
    let page = params.page ?? 1;
    for (let i = 0; i < maxPages; i += 1) {
      const result = await this.search({ ...params, page });
      for (const record of result.records) yield record;
      if (!result.hasMore || result.records.length === 0) return;
      page += 1;
    }
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Coverage must be measured before D-TRO is shown to anyone.
 *
 * This deliberately has no default answer: an unconfigured or unmeasured
 * authority reports UNAVAILABLE, never "probably fine".
 */
export interface DTroCoverageAssessment {
  readonly authoritySlug: string;
  readonly status: 'LIVE' | 'PLANNED' | 'UNAVAILABLE';
  readonly recordsFound: number;
  readonly measuredAt: string | null;
  readonly notes: string;
}

export function unmeasuredCoverage(authoritySlug: string): DTroCoverageAssessment {
  return {
    authoritySlug,
    status: 'UNAVAILABLE',
    recordsFound: 0,
    measuredAt: null,
    notes:
      'D-TRO coverage for this authority has not been measured. Restriction data is not shown until it has been.',
  };
}
