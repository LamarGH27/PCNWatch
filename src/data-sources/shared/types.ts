/**
 * Shared ingestion adapter contract.
 *
 * Every source (Camden today, other authorities later) implements this. The
 * pipeline that drives it — validate, normalise, geolocate, dedupe, upsert,
 * report — is source-agnostic, so adding an authority means writing a mapper,
 * not a new pipeline.
 */

export interface IngestionReport {
  fetched: number;
  accepted: number;
  rejected: number;
  inserted: number;
  updated: number;
  unchanged: number;
  geolocated: number;
  notGeolocated: number;
  errors: number;
}

export function emptyReport(): IngestionReport {
  return {
    fetched: 0,
    accepted: 0,
    rejected: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    geolocated: 0,
    notGeolocated: 0,
    errors: 0,
  };
}

export interface IngestionError {
  readonly sourceRecordId: string | null;
  readonly rowNumber: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  /** Payload excerpt with personal fields already removed. */
  readonly rawExcerpt: Record<string, unknown> | null;
}

/** A PCN event after normalisation, ready to upsert. Contains no personal data. */
export interface NormalisedPcnEvent {
  readonly sourceRecordId: string;
  readonly authoritySlug: string;
  readonly contraventionCode: string | null;
  readonly enforcementType: 'PARKING' | 'BUS_LANE' | 'MOVING_TRAFFIC' | 'UNKNOWN';
  /** ISO date, UTC. */
  readonly issuedDate: string;
  /** Full ISO timestamp when the source gave a time; null when it gave only a date. */
  readonly issuedAt: string | null;
  readonly issuedHour: number | null;
  readonly issuedDayOfWeek: number | null;
  readonly streetName: string;
  readonly streetNameNormalised: string;
  readonly locationSlug: string;
  readonly locality: string | null;
  readonly postcodeDistrict: string | null;
  /** null when the source gave no usable coordinates. Never approximated. */
  readonly longitude: number | null;
  readonly latitude: number | null;
  readonly dataConfidence: number;
  readonly sourceMetadata: Record<string, unknown>;
  readonly rowHash: string;
}

export interface NormalisationOutcome {
  readonly ok: true;
  readonly event: NormalisedPcnEvent;
  readonly warnings: readonly string[];
}

export interface NormalisationFailure {
  readonly ok: false;
  readonly error: IngestionError;
}

export type NormalisationResult = NormalisationOutcome | NormalisationFailure;

export interface SourceDescriptor {
  readonly slug: string;
  readonly name: string;
  readonly publisher: string;
  readonly licence: string | null;
  readonly licenceUrl: string | null;
  readonly sourceUrl: string | null;
  readonly attributionText: string;
  readonly coverageNotes: string;
}

export interface FetchResult {
  readonly rows: readonly unknown[];
  readonly versionLabel: string;
  readonly contentHash: string;
  readonly retrievedAt: string;
  readonly sourceEffectiveDate: string | null;
}

export interface IngestionAdapter {
  readonly descriptor: SourceDescriptor;
  /** Retrieves raw rows from the source. Throws on transport or schema failure. */
  fetch(options: { readonly since?: string; readonly limit?: number }): Promise<FetchResult>;
  /** Validates and normalises one raw row. Never throws; failures are returned. */
  normalise(row: unknown, rowNumber: number): NormalisationResult;
}
