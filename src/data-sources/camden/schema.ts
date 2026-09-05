import { z } from 'zod';

/**
 * Schema for rows returned by Camden's open PCN dataset.
 *
 * The dataset is published through a Socrata-style API which returns every column
 * as a string. Rather than assume exact column names, the adapter accepts a set of
 * plausible aliases per logical field and resolves them once, recording which alias
 * it used in the ingestion report. A source that changes its column names then
 * produces a loud validation failure instead of a silent field of nulls.
 */

/**
 * A Socrata "point" / "location" column, which arrives as a nested object rather
 * than a scalar. This is the shape most likely to differ between a hand-written
 * fixture and the live dataset, so it is modelled explicitly rather than being
 * treated as an unexpected value.
 *
 * Socrata emits two variants:
 *   - legacy `location`: { latitude: "51.53", longitude: "-0.13", human_address }
 *   - GeoJSON `point`:   { type: "Point", coordinates: [lon, lat] }
 */
const latLonPointSchema = z
  .object({
    latitude: z.union([z.string(), z.number()]),
    longitude: z.union([z.string(), z.number()]),
  })
  .loose();

const geoJsonPointSchema = z
  .object({
    type: z.literal('Point'),
    coordinates: z.tuple([z.number(), z.number()]),
  })
  .loose();

/**
 * Raw row.
 *
 * Values may be scalars or nested objects. A nested value never rejects the row —
 * an unrecognised one is simply not usable as a field, and the PII guard drops it
 * from retained metadata because its shape cannot be reviewed. Rejecting the whole
 * row would mean one new column on the source discards the entire dataset.
 */
export const rawRowSchema = z.record(z.string(), z.unknown());

export type RawRow = z.infer<typeof rawRowSchema>;

/** Extracts coordinates from a Socrata point/location column, if that is what it is. */
export function readSocrataPoint(value: unknown): { longitude: number; latitude: number } | null {
  const geoJson = geoJsonPointSchema.safeParse(value);
  if (geoJson.success) {
    const [longitude, latitude] = geoJson.data.coordinates;
    return { longitude, latitude };
  }

  const latLon = latLonPointSchema.safeParse(value);
  if (latLon.success) {
    const longitude = Number(latLon.data.longitude);
    const latitude = Number(latLon.data.latitude);
    if (Number.isFinite(longitude) && Number.isFinite(latitude)) return { longitude, latitude };
  }

  return null;
}

/**
 * Logical fields and the source column names that may supply them.
 * Order matters: the first alias present in a row wins.
 */
export const FIELD_ALIASES = {
  // `socrata_id` is the stable per-row identifier in Camden's published dataset.
  recordId: ['socrata_id', 'pcn_id', 'pcn_reference', 'reference', 'id', 'ticket_id', 'notice_number'],
  contraventionCode: ['contravention_code', 'contravention', 'code', 'cont_code'],
  // Camden publishes the suffix in its own column rather than inside the code.
  contraventionSuffix: ['contravention_code_suffix', 'contravention_suffix'],
  contraventionDescription: ['contravention_code_description', 'contravention_description'],
  // `contravention_date` is when the contravention happened. It is listed first
  // because it is the only date on Camden's dataset that describes the event;
  // see NEVER_EVENT_TIME below for why that distinction is enforced, not assumed.
  issuedTimestamp: [
    'contravention_date',
    'issue_datetime',
    'date_time_issued',
    'issued_datetime',
    'observation_datetime',
    'datetime',
  ],
  issuedDate: ['contravention_date', 'issue_date', 'date_issued', 'date', 'ticket_date', 'observation_date'],
  issuedTime: ['contravention_time', 'issue_time', 'time_issued', 'time', 'observation_time'],
  street: ['street', 'street_name', 'location', 'road_name', 'street_location', 'place'],
  locality: ['controlled_parking_zone_area', 'locality', 'area', 'ward', 'ward_name'],
  postcode: ['postcode', 'post_code', 'postcode_district'],
  longitude: ['longitude', 'lon', 'lng', 'x'],
  latitude: ['latitude', 'lat', 'y'],
  enforcementType: ['ticket_type', 'type', 'enforcement_type', 'pcn_type'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Columns that must NEVER be read as the time the contravention happened,
 * however plausible their name looks to a future maintainer.
 *
 * `last_uploaded` is when Camden last refreshed the row in its open-data
 * platform. Treating it as the event time would silently restate the entire
 * dataset as having happened on a handful of publication dates, which would
 * destroy every temporal figure the product makes — trends, busiest hours,
 * recency weighting and the period windows the Ticket Activity Score is
 * computed over — while looking perfectly healthy in the ingestion report.
 *
 * This is enforced in `resolveField` rather than left to the alias lists, so
 * adding such a column to a date alias by mistake cannot take effect.
 */
export const NEVER_EVENT_TIME: readonly string[] = [
  'last_uploaded',
  'last_updated',
  'uploaded_at',
  'published_at',
  'extracted_at',
  'ingested_at',
  'row_updated',
  ':updated_at',
  ':created_at',
];

/** Logical fields that describe when the contravention occurred. */
const EVENT_TIME_FIELDS: readonly string[] = ['issuedTimestamp', 'issuedDate', 'issuedTime'];

export function isForbiddenEventTimeColumn(column: string): boolean {
  const normalised = column.toLowerCase().trim();
  return NEVER_EVENT_TIME.some((f) => normalised === f || normalised.endsWith(f));
}

export type LogicalField = keyof typeof FIELD_ALIASES;

/**
 * Fields that may be retained in `source_metadata`.
 *
 * Everything not listed here is dropped by the PII guard, including any column
 * the dataset gains in future. Adding a field to this list is a deliberate,
 * reviewable act.
 */
export const RETAINABLE_METADATA_FIELDS: readonly string[] = [
  // Contravention detail — lets a location page explain a code we hold no
  // reference record for, and lets us check our records against the publisher's.
  'contravention_code',
  'contravention_code_description',
  'contravention_code_suffix',
  'contravention',
  'code',
  'cont_code',

  // Enforcement class and channel. Retained because conflating a moving-traffic
  // contravention with a parking one would misdescribe what is being measured.
  'ticket_type',
  'ticket_description',
  'ticket_issued_via_cctv_camera',
  'type',
  'enforcement_type',
  'pcn_type',

  // Location context. The zone is the only areal unit Camden publishes and is
  // the most promising key for deriving geometry.
  'controlled_parking_zone_area',
  'street',
  'street_name',
  'road_name',
  'place',
  'locality',
  'area',
  'ward',
  'ward_name',

  // Camden's own statement about how precisely this row is located. Retained
  // because any geometry we later derive must be labelled no more precisely
  // than the source claims.
  'spatial_accuracy',

  // Charge band, which is how we could one day check a demanded amount against
  // what the authority says applies.
  'charging_band_description',

  // Publication timestamp. Retained for provenance only — never as event time.
  'last_uploaded',
];

/**
 * Deliberately NOT retained.
 *
 * `status_of_case`, `formal_representation`, `has_appeal`,
 * `penalty_charge_notice_cancelled`, `penalty_charge_notice_written_off`,
 * `vehicle_removed`, `vehicle_category`, `foreign_vehicle`, `cancellation_reason`
 * and `cancellation_reason_description` describe the outcome and subject of an
 * individual penalty. PCNWatch's public tables measure where enforcement
 * happened, not what became of any particular notice, and outcome fields narrow
 * a record towards a specific vehicle and person. They are dropped at ingestion
 * rather than stored and filtered later.
 *
 * `contravention_in_last_7_days` is dropped for a different reason: it is true
 * relative to the moment the publisher generated the extract, so storing it
 * would store an assertion that silently becomes false. We hold the
 * contravention date and can derive recency correctly at read time.
 *
 * `civil_enforcement_officer_error` and `country_vehicle_registered_to` never
 * reach this list — the field-name guard rejects them before the allow-list is
 * consulted, the first as an officer identifier and the second as a vehicle
 * registration attribute.
 */
export const DELIBERATELY_DROPPED_FIELDS: readonly string[] = [
  'status_of_case',
  'formal_representation',
  'has_appeal',
  'penalty_charge_notice_cancelled',
  'penalty_charge_notice_written_off',
  'vehicle_removed',
  'vehicle_category',
  'foreign_vehicle',
  'cancellation_reason',
  'cancellation_reason_description',
  'contravention_in_last_7_days',
];

/** Fields kept on an ingestion_errors excerpt so a human can debug a rejection. */
export const ERROR_EXCERPT_FIELDS: readonly string[] = [
  ...new Set([
    ...FIELD_ALIASES.recordId,
    ...FIELD_ALIASES.contraventionCode,
    ...FIELD_ALIASES.issuedTimestamp,
    ...FIELD_ALIASES.issuedDate,
    ...FIELD_ALIASES.street,
    ...FIELD_ALIASES.longitude,
    ...FIELD_ALIASES.latitude,
  ]),
];

/**
 * Resolves a logical field to the first alias present as a usable *scalar*.
 *
 * Nested values are skipped rather than stringified: `String({})` yields
 * "[object Object]", which would sail through as a street name.
 */
export function resolveField(row: RawRow, field: LogicalField): { key: string; value: unknown } | null {
  const isEventTime = EVENT_TIME_FIELDS.includes(field);
  for (const alias of FIELD_ALIASES[field]) {
    // A publication timestamp is never the event time, whatever the alias list says.
    if (isEventTime && isForbiddenEventTimeColumn(alias)) continue;
    const value = row[alias];
    if (value === undefined || value === null) continue;
    if (typeof value === 'object') continue;
    if (String(value).trim() === '') continue;
    return { key: alias, value };
  }
  return null;
}

/** Column names that may carry a Socrata point/location object. */
export const POINT_FIELD_CANDIDATES: readonly string[] = [
  'location',
  'point',
  'geocoded_column',
  'the_geom',
  'coordinates',
  'geo_point',
  'geom',
];

/** Finds coordinates in whichever column carries them, if any. */
export function resolvePoint(
  row: RawRow,
): { key: string; longitude: number; latitude: number } | null {
  for (const key of POINT_FIELD_CANDIDATES) {
    const point = readSocrataPoint(row[key]);
    if (point) return { key, ...point };
  }
  // Fall back to scanning every column, so a differently named point column still
  // works rather than silently costing us every coordinate in the dataset.
  for (const [key, value] of Object.entries(row)) {
    if (typeof value !== 'object' || value === null) continue;
    const point = readSocrataPoint(value);
    if (point) return { key, ...point };
  }
  return null;
}

/**
 * Camden's approximate bounding box in WGS84.
 *
 * Used to reject coordinates that cannot plausibly be in the borough — swapped
 * lat/long, null island, or an unconverted British National Grid easting.
 * Padded generously; the point is to catch corruption, not to clip the boundary.
 */
export const CAMDEN_BBOX = {
  minLon: -0.24,
  minLat: 51.5,
  maxLon: -0.08,
  maxLat: 51.6,
} as const;
