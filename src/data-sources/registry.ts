import type { IngestionAdapter } from './shared/types';
import {
  CAMDEN_AUTHORITY_SLUG,
  CAMDEN_SOURCE,
  camdenDatasetUrl,
  createCamdenAdapter,
} from './camden/adapter';
import {
  BARNET_AUTHORITY_SLUG,
  BARNET_SOURCE,
  barnetFilesFromEnv,
  createBarnetAdapter,
} from './barnet/adapter';

/**
 * The sources PCNWatch knows how to ingest.
 *
 * One explicit list, because the alternative is a runner that grows a branch
 * per borough and a set of environment variables nobody can enumerate. A source
 * is ingestible if and only if it appears here.
 *
 * Deliberately fail-closed in both directions:
 *
 *   * an unknown slug is refused by name, never defaulted to the first entry —
 *     a typo must not quietly ingest Camden's dataset under another borough's
 *     authority;
 *   * registration says nothing about whether a borough is *shown*. That is
 *     `COVERAGE_SCOPE.liveAuthoritySlugs`, and it is a separate decision on
 *     purpose: a source can be registered, ingested and inspected long before
 *     anybody is told it exists.
 */

export interface SourceRegistration {
  /** Stable source slug, matching `data_sources.slug`. */
  readonly sourceSlug: string;
  /** The authority the ingested events belong to, matching `authorities.slug`. */
  readonly authoritySlug: string;
  /** Human label for CLI output. */
  readonly label: string;
  /**
   * The publisher's own host.
   *
   * A run against anything else is recorded as demo data, so the coverage layer
   * refuses to present it as real enforcement activity. Held per source because
   * "official" means a different hostname for every authority.
   */
  readonly officialHost: string;
  /** The dataset URL this source reads when none is overridden. */
  defaultDatasetUrl(): string;
  /** Builds the adapter. `datasetUrl` is already resolved by the caller. */
  create(options: {
    readonly datasetUrl: string;
    readonly onProgress?: (progress: { page: number; rowsSoFar: number }) => void;
  }): IngestionAdapter;
}

const REGISTRY: readonly SourceRegistration[] = [
  {
    sourceSlug: CAMDEN_SOURCE.slug,
    authoritySlug: CAMDEN_AUTHORITY_SLUG,
    label: CAMDEN_SOURCE.name,
    officialHost: 'opendata.camden.gov.uk',
    defaultDatasetUrl: camdenDatasetUrl,
    create: ({ datasetUrl, onProgress }) =>
      createCamdenAdapter({
        datasetUrl,
        onProgress,
        appToken: process.env.CAMDEN_APP_TOKEN,
      }),
  },
  {
    /*
     * Registered, and not live.
     *
     * Barnet's three datasets are readable, verified and ingestible, which is
     * what this list means. Whether anybody is told Barnet exists is
     * `COVERAGE_SCOPE.liveAuthoritySlugs`, and it does not contain Barnet — so
     * a run here fills a dataset version that no public surface reads.
     *
     * Barnet is a snapshot rather than a feed: it is published as CSV files
     * rather than an API, so `defaultDatasetUrl` names the dataset page a
     * human retrieved them from and the files themselves come from the
     * environment. That is also why the official-host check is against the
     * open-data portal: a run pointed anywhere else is recorded as demo.
     */
    sourceSlug: BARNET_SOURCE.slug,
    authoritySlug: BARNET_AUTHORITY_SLUG,
    label: BARNET_SOURCE.name,
    officialHost: 'open.barnet.gov.uk',
    defaultDatasetUrl: () => 'https://open.barnet.gov.uk/',
    create: () => createBarnetAdapter({ files: barnetFilesFromEnv() }),
  },
];

export function listSources(): readonly SourceRegistration[] {
  return REGISTRY;
}

export function knownSourceSlugs(): readonly string[] {
  return REGISTRY.map((source) => source.sourceSlug);
}

/** A registration, or null. Callers that must have one use `requireSource`. */
export function getSource(sourceSlug: string): SourceRegistration | null {
  return REGISTRY.find((source) => source.sourceSlug === sourceSlug) ?? null;
}

export class UnknownSourceError extends Error {
  constructor(readonly requested: string) {
    super(
      `Unknown ingestion source "${requested}". Known sources: ${knownSourceSlugs().join(', ')}.`,
    );
    this.name = 'UnknownSourceError';
  }
}

/**
 * A registration, or a refusal naming what is available.
 *
 * Never falls back to a default source. Ingesting the wrong borough's dataset
 * because of a mistyped argument would attribute one authority's enforcement to
 * another, and nothing downstream could detect it.
 */
export function requireSource(sourceSlug: string): SourceRegistration {
  const source = getSource(sourceSlug);
  if (!source) throw new UnknownSourceError(sourceSlug);
  return source;
}

/** Whether a URL belongs to the source's official publisher. */
export function isOfficialSourceUrl(source: SourceRegistration, url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(source.officialHost);
  } catch {
    return false;
  }
}
