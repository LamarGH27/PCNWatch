import {
  normaliseStreetName,
  parseCoordinates,
  parseContraventionCode,
  parsePostcodeDistrict,
  parseTrailingPostcodeDistrict,
  parseSourceTime,
  parseSourceTimestamp,
  rowHash,
  slugify,
  contentHash,
} from '../shared/normalise';
import { sanitiseErrorExcerpt, sanitiseSourceMetadata } from '../shared/pii';
import type {
  FetchResult,
  IngestionAdapter,
  NormalisationResult,
  SourceDescriptor,
} from '../shared/types';
import {
  type GeometryResult,
  type NoGeometryReason,
  type SourceLocation,
  hasGeometry,
  noGeometry,
  sourcePublishedGeometry,
} from '@/core/geography/types';
import { getStreetReference } from '@/core/geography/street-reference';
import { classifyEnforcement } from './enforcement-class';
import {
  CAMDEN_BBOX,
  ERROR_EXCERPT_FIELDS,
  RETAINABLE_METADATA_FIELDS,
  rawRowSchema,
  resolveField,
  resolvePoint,
  type RawRow,
} from './schema';

export const CAMDEN_AUTHORITY_SLUG = 'camden';

export const CAMDEN_SOURCE: SourceDescriptor = {
  slug: 'camden-pcn',
  name: 'Camden penalty charge notices',
  publisher: 'London Borough of Camden',
  licence: 'Open Government Licence v3.0',
  licenceUrl: 'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  sourceUrl: 'https://opendata.camden.gov.uk/',
  attributionText:
    'Contains public sector information from the London Borough of Camden licensed under the Open Government Licence v3.0.',
  coverageNotes:
    'Penalty charge notices issued in the London Borough of Camden. Coverage is limited to what Camden publishes; it is not a complete record of all enforcement activity.',
};

export class CamdenFetchError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_CONFIGURED'
      | 'TRANSPORT_ERROR'
      | 'BAD_STATUS'
      | 'MALFORMED_PAYLOAD',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CamdenFetchError';
  }
}

export interface CamdenAdapterOptions {
  /** Full dataset query URL. Absent means the adapter refuses to run. */
  readonly datasetUrl?: string;
  /** Optional Socrata app token, sent as a header. Raises the rate limit. */
  readonly appToken?: string;
  /** Injected for tests. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  readonly pageSize?: number;
  /** Maximum pages to walk in one run, so a runaway source cannot spin forever. */
  readonly maxPages?: number;
}

export function createCamdenAdapter(options: CamdenAdapterOptions = {}): IngestionAdapter {
  const pageSize = options.pageSize ?? 5000;
  const maxPages = options.maxPages ?? 200;

  return {
    descriptor: CAMDEN_SOURCE,

    async fetch({ since, limit }): Promise<FetchResult> {
      const { datasetUrl } = options;
      if (!datasetUrl) {
        // The correct boundary when a source is not configured: refuse loudly.
        // Never return an empty result set, which downstream would read as
        // "Camden issued no PCNs".
        throw new CamdenFetchError(
          'CAMDEN_PCN_DATASET_URL is not configured, so the Camden dataset cannot be fetched.',
          'NOT_CONFIGURED',
        );
      }

      const doFetch = options.fetchImpl ?? fetch;
      const rows: unknown[] = [];
      const retrievedAt = new Date().toISOString();
      let offset = 0;

      for (let page = 0; page < maxPages; page += 1) {
        const url = new URL(datasetUrl);
        url.searchParams.set('$limit', String(Math.min(pageSize, limit ?? pageSize)));
        url.searchParams.set('$offset', String(offset));
        // Stable ordering is required for correct pagination.
        if (!url.searchParams.has('$order')) url.searchParams.set('$order', ':id');
        if (since) url.searchParams.set('$where', `issue_date >= '${since}'`);

        let response: Response;
        try {
          response = await doFetch(url.toString(), {
            headers: {
              accept: 'application/json',
              ...(options.appToken ? { 'X-App-Token': options.appToken } : {}),
            },
          });
        } catch (cause) {
          throw new CamdenFetchError(
            `Could not reach the Camden dataset: ${(cause as Error).message}`,
            'TRANSPORT_ERROR',
            cause,
          );
        }

        if (!response.ok) {
          throw new CamdenFetchError(
            `Camden dataset returned HTTP ${response.status}.`,
            'BAD_STATUS',
            { status: response.status },
          );
        }

        let payload: unknown;
        try {
          payload = await response.json();
        } catch (cause) {
          throw new CamdenFetchError(
            'Camden dataset returned a body that is not valid JSON.',
            'MALFORMED_PAYLOAD',
            cause,
          );
        }

        if (!Array.isArray(payload)) {
          throw new CamdenFetchError(
            'Camden dataset returned a payload that is not an array of rows.',
            'MALFORMED_PAYLOAD',
            { received: typeof payload },
          );
        }

        rows.push(...payload);
        if (payload.length < pageSize) break;
        if (limit !== undefined && rows.length >= limit) break;
        offset += payload.length;
      }

      const finalRows = limit === undefined ? rows : rows.slice(0, limit);
      const hash = contentHash(finalRows);

      return {
        rows: finalRows,
        versionLabel: `${retrievedAt.slice(0, 10)}-${hash.slice(0, 12)}`,
        contentHash: hash,
        retrievedAt,
        sourceEffectiveDate: null,
      };
    },

    normalise(row: unknown, rowNumber: number): NormalisationResult {
      return normaliseCamdenRow(row, rowNumber);
    },
  };
}

/**
 * Validates and normalises a single Camden row.
 *
 * Never throws. A row that cannot be trusted is returned as a structured failure
 * so the pipeline can record it against the ingestion run — a malformed row is
 * evidence about the source, not something to discard quietly.
 */
export function normaliseCamdenRow(row: unknown, rowNumber: number): NormalisationResult {
  const parsed = rawRowSchema.safeParse(row);
  if (!parsed.success) {
    return failure(rowNumber, null, 'ROW_NOT_AN_OBJECT', 'Row is not a JSON object.', row);
  }
  const raw: RawRow = parsed.data;
  const warnings: string[] = [];

  /* -- Identity ----------------------------------------------------------- */

  const recordIdField = resolveField(raw, 'recordId');
  if (!recordIdField) {
    return failure(
      rowNumber,
      null,
      'MISSING_RECORD_ID',
      'Row has no recognisable source record identifier, so it cannot be deduplicated.',
      raw,
    );
  }
  const sourceRecordId = String(recordIdField.value).trim();

  /* -- Timing ------------------------------------------------------------- */

  const timestampField = resolveField(raw, 'issuedTimestamp');
  const dateField = resolveField(raw, 'issuedDate');
  let timing = timestampField ? parseSourceTimestamp(timestampField.value) : null;

  if (!timing && dateField) {
    timing = parseSourceTimestamp(dateField.value);
    // A separate time column can supply the hour the date column lacks.
    const timeField = resolveField(raw, 'issuedTime');
    if (timing && timeField) {
      const time = parseSourceTime(timeField.value);
      if (time) {
        const combined = new Date(`${timing.date}T00:00:00.000Z`);
        combined.setUTCHours(time.hour, time.minute, 0, 0);
        timing = {
          date: timing.date,
          timestamp: combined.toISOString(),
          hour: time.hour,
          dayOfWeek: combined.getUTCDay(),
        };
      } else {
        warnings.push('TIME_UNPARSEABLE');
      }
    }
  }

  if (!timing) {
    return failure(
      rowNumber,
      sourceRecordId,
      'MISSING_OR_INVALID_DATE',
      'Row has no valid issue date. A PCN with no date cannot be placed in any time period.',
      raw,
    );
  }

  // A future-dated PCN indicates a source error, not a real event.
  const today = new Date().toISOString().slice(0, 10);
  if (timing.date > today) {
    return failure(
      rowNumber,
      sourceRecordId,
      'DATE_IN_FUTURE',
      `Issue date ${timing.date} is in the future.`,
      raw,
    );
  }
  if (timing.date < '2000-01-01') {
    return failure(
      rowNumber,
      sourceRecordId,
      'DATE_IMPLAUSIBLE',
      `Issue date ${timing.date} predates civil parking enforcement records.`,
      raw,
    );
  }

  /* -- Location ----------------------------------------------------------- */

  const streetField = resolveField(raw, 'street');
  if (!streetField) {
    return failure(
      rowNumber,
      sourceRecordId,
      'MISSING_STREET',
      'Row has no street or location name, so it cannot be attributed to a place.',
      raw,
    );
  }
  const streetName = String(streetField.value).trim();
  const streetNameNormalised = normaliseStreetName(streetName);
  if (!streetNameNormalised) {
    return failure(
      rowNumber,
      sourceRecordId,
      'STREET_NOT_NORMALISABLE',
      `Street value "${streetName}" contains no usable characters.`,
      raw,
    );
  }

  // Coordinates may arrive either as two scalar columns or as a single nested
  // Socrata point/location object. Both are supported; scalars win when present
  // because they are the more explicit signal.
  const lonField = resolveField(raw, 'longitude');
  const latField = resolveField(raw, 'latitude');
  const nestedPoint = resolvePoint(raw);

  const sourcePublishesCoordinates = Boolean(lonField || latField || nestedPoint);
  let sourcePoint: { longitude: number; latitude: number } | null = null;
  let coordinateSource: string | null = null;

  if (lonField && latField) {
    sourcePoint = parseCoordinates(lonField.value, latField.value, CAMDEN_BBOX);
    coordinateSource = sourcePoint ? `${lonField.key}/${latField.key}` : null;
    if (!sourcePoint) warnings.push('COORDINATES_OUT_OF_RANGE');
  }

  if (!sourcePoint && nestedPoint) {
    sourcePoint = parseCoordinates(nestedPoint.longitude, nestedPoint.latitude, CAMDEN_BBOX);
    coordinateSource = sourcePoint ? nestedPoint.key : null;
    if (!sourcePoint) warnings.push('COORDINATES_OUT_OF_RANGE');
  }

  if (!sourcePublishesCoordinates) warnings.push('COORDINATES_ABSENT');

  /* -- Contravention ------------------------------------------------------ */

  const codeField = resolveField(raw, 'contraventionCode');
  const contravention = codeField ? parseContraventionCode(codeField.value) : null;
  if (codeField && !contravention) warnings.push('CONTRAVENTION_CODE_UNPARSEABLE');
  if (!codeField) warnings.push('CONTRAVENTION_CODE_ABSENT');

  // Camden publishes the suffix in its own column. Prefer that over the letter
  // parsed out of the code, which is only a fallback for sources that inline it.
  const suffixField = resolveField(raw, 'contraventionSuffix');
  const suffix =
    (suffixField ? String(suffixField.value).trim().toLowerCase() : null) || contravention?.suffix || null;

  const descriptionField = resolveField(raw, 'contraventionDescription');

  // Enforcement class. An unrecognised ticket type becomes UNKNOWN and is
  // counted separately; it is never assumed to be parking.
  const enforcementTypeField = resolveField(raw, 'enforcementType');
  // The two descriptions are different evidence and are passed separately:
  // `ticket_description` labels the enforcement regime ("On Street
  // Contravention"), `contravention_code_description` says what the driver
  // actually did ("Parked in a residents' bay"). Only the second can resolve a
  // ticket type whose meaning the source does not spell out.
  const classification = classifyEnforcement(
    enforcementTypeField?.value,
    raw.ticket_description,
    raw.ticket_issued_via_cctv_camera,
    descriptionField?.value,
  );
  const enforcementType = classification.enforcementClass;
  if (!classification.recognised) {
    warnings.push(
      classification.rawTicketType ? 'ENFORCEMENT_TYPE_UNRECOGNISED' : 'ENFORCEMENT_TYPE_ABSENT',
    );
  }

  const localityField = resolveField(raw, 'locality');
  const postcodeField = resolveField(raw, 'postcode');

  /* -- Geography ----------------------------------------------------------- */

  // A. What the authority published about where this notice was issued.
  const sourceLocation: SourceLocation = {
    streetName,
    streetNameNormalised,
    locality: localityField ? String(localityField.value).trim() : null,
    // The source has no postcode column; Camden puts the district inside the
    // street value. Reading it out is a derivation from the source's own text,
    // not an external lookup, so it is A-side information — but it is recorded
    // as derived so nobody mistakes it for a published field.
    postcodeDistrict: postcodeField
      ? parsePostcodeDistrict(postcodeField.value)
      : parseTrailingPostcodeDistrict(streetName),
    publisherSpatialAccuracy:
      typeof raw.spatial_accuracy === 'string' && raw.spatial_accuracy.trim() !== ''
        ? raw.spatial_accuracy.trim()
        : null,
  };

  // B. A coordinate, if one can be justified. A source-published point is used
  // as-is; otherwise the street reference is asked, and today it declines. No
  // branch of this produces a coordinate without provenance.
  const geometry: GeometryResult = sourcePoint
    ? sourcePublishedGeometry(sourcePoint.longitude, sourcePoint.latitude, coordinateSource ?? 'unknown')
    : sourcePublishesCoordinates
      ? geometryOrReference(sourceLocation, 'SOURCE_COORDINATES_UNUSABLE')
      : geometryOrReference(sourceLocation, 'SOURCE_PUBLISHES_NO_COORDINATES');

  if (!hasGeometry(geometry)) warnings.push(`NO_GEOMETRY_${geometry.reason}`);

  /* -- Provenance and confidence ------------------------------------------ */

  const sanitised = sanitiseSourceMetadata(raw, RETAINABLE_METADATA_FIELDS);
  const dataConfidence = scoreConfidence({
    hasCoordinates: hasGeometry(geometry),
    hasContravention: contravention !== null,
    hasTime: timing.hour !== null,
    hasLocality: localityField !== null,
  });

  return {
    ok: true,
    warnings: [
      ...warnings,
      ...(sanitised.forbiddenFields.length > 0 ? ['SOURCE_CONTAINED_PERSONAL_FIELDS'] : []),
      ...(sanitised.redactedFields.length > 0 ? ['SOURCE_VALUE_REDACTED'] : []),
    ],
    event: {
      sourceRecordId,
      authoritySlug: CAMDEN_AUTHORITY_SLUG,
      contraventionCode: contravention?.code ?? null,
      enforcementType,
      issuedDate: timing.date,
      issuedAt: timing.timestamp,
      issuedHour: timing.hour,
      issuedDayOfWeek: timing.dayOfWeek,
      streetName,
      streetNameNormalised,
      locationSlug: slugify(streetNameNormalised),
      locality: sourceLocation.locality,
      postcodeDistrict: sourceLocation.postcodeDistrict,
      longitude: geometry.longitude,
      latitude: geometry.latitude,
      dataConfidence,
      sourceMetadata: {
        ...sanitised.metadata,
        _resolvedFields: {
          recordId: recordIdField.key,
          street: streetField.key,
          date: timestampField?.key ?? dateField?.key ?? null,
          contravention: codeField?.key ?? null,
          coordinates: coordinateSource,
          enforcementType: enforcementTypeField?.key ?? null,
        },
        _contraventionSuffix: suffix,
        _geometry: {
          precision: geometry.precision,
          ...geometry.provenance,
          ...(hasGeometry(geometry) ? {} : { reason: geometry.reason }),
        },
        _publisherSpatialAccuracy: sourceLocation.publisherSpatialAccuracy,
        _postcodeDistrictSource:
          sourceLocation.postcodeDistrict === null
            ? null
            : postcodeField
              ? 'PUBLISHED_COLUMN'
              : 'DERIVED_FROM_STREET_VALUE',
        _enforcementClass: enforcementType,
        _enforcementClassRecognised: classification.recognised,
        _enforcementClassBasis: classification.basis,
        _viaCctv: classification.viaCctv,
        _droppedFieldCount: sanitised.droppedFields.length,
      },
      rowHash: rowHash([
        sourceRecordId,
        timing.timestamp ?? timing.date,
        streetNameNormalised,
        contravention?.code ?? null,
        geometry.longitude,
        geometry.latitude,
      ]),
    },
  };
}

/**
 * Ask the street reference for geometry the source did not publish.
 *
 * When no reference is configured this returns the *source's* reason rather
 * than the resolver's, so an ingestion report distinguishes "this dataset has no
 * geography" from "geography was there and we could not read it".
 */
function geometryOrReference(
  location: SourceLocation,
  sourceReason: NoGeometryReason,
): GeometryResult {
  const reference = getStreetReference();
  if (!reference.available) return noGeometry(sourceReason);
  // A configured reference gives its own reason when it cannot match a street.
  return reference.resolve(location);
}

/**
 * Per-row data confidence in [0,1].
 *
 * Confidence describes how completely a row is specified, which is exactly what
 * the Ticket Activity Score needs in order to shrink uncertain locations toward
 * the middle. A row with no geometry cannot be mapped at all, so it is capped low.
 */
export function scoreConfidence(signals: {
  hasCoordinates: boolean;
  hasContravention: boolean;
  hasTime: boolean;
  hasLocality: boolean;
}): number {
  let confidence = 0.4; // A row with a valid id, date and street starts here.
  if (signals.hasCoordinates) confidence += 0.3;
  if (signals.hasContravention) confidence += 0.15;
  if (signals.hasTime) confidence += 0.1;
  if (signals.hasLocality) confidence += 0.05;
  if (!signals.hasCoordinates) confidence = Math.min(confidence, 0.35);
  return Math.round(Math.min(1, confidence) * 1000) / 1000;
}

function failure(
  rowNumber: number,
  sourceRecordId: string | null,
  errorCode: string,
  errorMessage: string,
  raw: unknown,
): NormalisationResult {
  const excerpt = sanitiseErrorExcerpt(raw, ERROR_EXCERPT_FIELDS);

  // A PCN reference is shaped like an old dateless registration ("CA1"), so the
  // registration scrubber redacts it. That costs us the one field that makes a
  // rejection debuggable, for no privacy gain: a notice reference is not a
  // vehicle registration, and it is already stored unredacted in its own column.
  if (excerpt && sourceRecordId) excerpt._sourceRecordId = sourceRecordId;

  return {
    ok: false,
    error: { rowNumber, sourceRecordId, errorCode, errorMessage, rawExcerpt: excerpt },
  };
}
