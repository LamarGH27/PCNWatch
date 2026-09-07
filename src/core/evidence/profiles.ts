import type { EvidenceField } from './analysis';
import type { EvidenceType } from './types';

/**
 * What may be read off each kind of evidence, and what the reader is told.
 *
 * This is the per-type extraction contract. One response schema is shared —
 * every reading is a field, a value and a status, whatever the document — but
 * the set of fields that may appear differs by type, and an observation outside
 * its type's set is discarded rather than kept.
 *
 * That discard is the point of the file. A reader shown a photograph of a road
 * marking has no business returning a permit expiry date, and the cheapest way
 * to make sure one never reaches a case is to have nowhere to put it. Filtering
 * after the fact rather than trusting the prompt means the guarantee survives a
 * prompt edit, a model change and a jailbreak in the image itself.
 *
 * Types absent from this table are not read at all. They can still be uploaded
 * and held — a witness statement or a garage invoice is worth having on the
 * case — but nothing machine-reads them, so nothing about them can be confirmed
 * and they never reach the evidence basis. That is a conservative starting
 * line, not a permanent one: free prose is exactly where a reader would be most
 * likely to invent, and adding a type here later is a deliberate act.
 */

export interface EvidenceAnalysisProfile {
  readonly type: EvidenceType;
  /** What the reader is told it is looking at. Plain description, no legal content. */
  readonly describedAs: string;
  /** The only fields an observation on this type may use. */
  readonly fields: readonly EvidenceField[];
  /** Type-specific reading instructions. Never a rule, never an interpretation. */
  readonly readingGuidance: string;
}

const PROFILES: readonly EvidenceAnalysisProfile[] = [
  {
    type: 'PCN_IMAGE',
    describedAs: 'a photograph or scan of a UK penalty charge notice',
    fields: [
      'VEHICLE_REGISTRATION',
      'DATE',
      'TIME_FROM',
      'CONTRAVENTION_CODE',
      'LOCATION_TEXT',
      'AMOUNT',
      'REFERENCE_NUMBER',
      'ISSUING_BODY',
    ],
    readingGuidance:
      'Copy the registration, the date and time of the alleged contravention, the ' +
      'contravention code, the location line, the amount demanded, the notice number ' +
      'and the issuing body, exactly as printed. Do not calculate or restate any deadline.',
  },
  {
    type: 'COUNCIL_PHOTOGRAPHS',
    describedAs: 'an enforcement photograph taken by a parking authority or its camera',
    fields: [
      'VEHICLE_REGISTRATION',
      'DATE',
      'TIME_FROM',
      'LOCATION_TEXT',
      'VEHICLE_POSITION_DESCRIPTION',
      'MARKINGS_DESCRIPTION',
      'SIGN_RESTRICTION_TEXT',
    ],
    readingGuidance:
      'Read any timestamp and registration burned into the image exactly as shown. ' +
      'Describe where the vehicle sits relative to any lines, kerb or bay, and any sign ' +
      'or marking legible in the frame. Describe only what is visible in this image. Do ' +
      'not say whether it shows a contravention.',
  },
  {
    type: 'PARKING_SIGN',
    describedAs: 'a photograph of a parking or waiting restriction sign',
    fields: ['SIGN_RESTRICTION_TEXT', 'SIGN_CONTROLLED_HOURS', 'ZONE_OR_BAY_IDENTIFIER', 'LOCATION_TEXT'],
    readingGuidance:
      'Transcribe the wording on the sign as written, including the days and hours ' +
      'exactly as they appear, and any zone or bay identifier. Transcribe; do not ' +
      'summarise, reword or explain what the sign permits.',
  },
  {
    type: 'ROAD_MARKINGS',
    describedAs: 'a photograph of road markings, bay lines or kerb markings',
    fields: ['MARKINGS_DESCRIPTION', 'LOCATION_TEXT', 'ZONE_OR_BAY_IDENTIFIER'],
    readingGuidance:
      'Describe the markings visible in the photograph: their colour, how many lines, ' +
      'whether they are continuous, worn, faded, interrupted or absent where the ' +
      'photograph shows the kerb. Describe what is in the frame and nothing beyond it.',
  },
  {
    type: 'VEHICLE_POSITION',
    describedAs: "a photograph showing where a vehicle was parked",
    fields: ['VEHICLE_REGISTRATION', 'VEHICLE_POSITION_DESCRIPTION', 'MARKINGS_DESCRIPTION', 'LOCATION_TEXT'],
    readingGuidance:
      'Describe where the vehicle sits in relation to any lines, kerb, bay or sign ' +
      'visible in the photograph, and read the registration if it is legible.',
  },
  {
    type: 'PAYMENT_RECEIPT',
    describedAs: 'a pay-and-display ticket, card receipt or other proof of a parking payment',
    fields: [
      'VEHICLE_REGISTRATION',
      'DATE',
      'TIME_FROM',
      'TIME_TO',
      'AMOUNT',
      'ZONE_OR_BAY_IDENTIFIER',
      'LOCATION_TEXT',
      'REFERENCE_NUMBER',
      'PROVIDER_NAME',
    ],
    readingGuidance:
      'Copy the registration, the date, the start and end of the paid period, the ' +
      'amount, any zone or machine identifier and the reference, exactly as printed. ' +
      'If only a start time and a duration are printed, read the start time and leave ' +
      'the end time out rather than working it out.',
  },
  {
    type: 'PARKING_APP_RECEIPT',
    describedAs: 'a parking app session confirmation, email or screenshot',
    fields: [
      'VEHICLE_REGISTRATION',
      'DATE',
      'TIME_FROM',
      'TIME_TO',
      'AMOUNT',
      'ZONE_OR_BAY_IDENTIFIER',
      'LOCATION_TEXT',
      'REFERENCE_NUMBER',
      'PROVIDER_NAME',
    ],
    readingGuidance:
      'Copy the registration the session was booked against, the date, the start and ' +
      'end of the session, the amount, the zone or location code and the session ' +
      'reference, exactly as shown. The registration on the session is the one shown; ' +
      'never correct it to one you have seen elsewhere.',
  },
  {
    type: 'PERMIT',
    describedAs: 'a parking permit, resident voucher, visitor voucher or dispensation',
    fields: [
      'VEHICLE_REGISTRATION',
      'PERMIT_TYPE',
      'VALID_FROM',
      'VALID_TO',
      'ZONE_OR_BAY_IDENTIFIER',
      'REFERENCE_NUMBER',
      'ISSUING_BODY',
    ],
    readingGuidance:
      'Copy the registration it is issued against, what it calls itself, the dates it ' +
      'is valid between, the zone it covers, its number and who issued it, exactly as ' +
      'printed. Do not say whether it was valid on any particular day.',
  },
  {
    type: 'BLUE_BADGE',
    describedAs: 'a disabled person’s Blue Badge',
    fields: ['BADGE_SERIAL', 'VALID_TO', 'ISSUING_BODY'],
    readingGuidance:
      'Read only the badge serial number, the expiry date and the issuing authority. ' +
      'Do not read, transcribe or describe the holder’s name, photograph or any ' +
      'other personal detail on the badge, and do not describe the person shown.',
  },
];

export const EVIDENCE_ANALYSIS_PROFILES: Partial<Record<EvidenceType, EvidenceAnalysisProfile>> =
  Object.fromEntries(PROFILES.map((p) => [p.type, p]));

/** Whether PCNWatch reads this kind of evidence at all. */
export function isAnalysable(type: EvidenceType): boolean {
  return type in EVIDENCE_ANALYSIS_PROFILES;
}

export function profileFor(type: EvidenceType): EvidenceAnalysisProfile | null {
  return EVIDENCE_ANALYSIS_PROFILES[type] ?? null;
}

/**
 * Why an item PCNWatch cannot read is still worth having.
 *
 * Said on the page rather than left implicit, because "uploaded, and it counts
 * for nothing" needs an explanation or it reads as a bug.
 */
export const UNREAD_EVIDENCE_NOTE =
  'We hold this, but PCNWatch does not read this kind of document automatically, so ' +
  'there is nothing for you to check and it is not counted as supporting your case. ' +
  'It stays on your case for you to use.';
