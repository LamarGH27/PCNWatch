import type { ReferenceRecord } from '../types';

/**
 * Contravention code reference records.
 *
 * SOURCE OF TRUTH: the published national list of parking contravention codes used
 * by London enforcement authorities. Every record below carries
 * `reviewStatus: 'PENDING_LEGAL_REVIEW'` and MUST be checked, word for word, against
 * the official published list before it is treated as verified.
 *
 * Rules for this file:
 *  - Only add a code when the official description is available to copy accurately.
 *  - `officialDescription` is a quotation target; do not paraphrase it here.
 *  - Unverified records are excluded from the sitemap and rendered `noindex`
 *    (see src/core/reference/store.ts → `isPubliclyIndexable`).
 *  - A missing code is correct behaviour. An invented code is a product failure.
 */

interface ContraventionContent {
  readonly code: string;
  readonly officialDescription: string;
  readonly plainEnglish: string;
  readonly enforcementType: 'PARKING' | 'BUS_LANE' | 'MOVING_TRAFFIC';
  readonly penaltyBand: 'HIGHER' | 'LOWER' | 'UNKNOWN';
  readonly suffixMeaning?: string;
  /** Questions of fact a user should be able to answer about their own case. */
  readonly commonFactualQuestions: readonly string[];
  /** Evidence type keys (see src/core/evidence/types.ts) commonly relevant. */
  readonly relevantEvidence: readonly string[];
}

function contravention(content: ContraventionContent): ReferenceRecord {
  return {
    key: `CONTRAVENTION-${content.code}`,
    version: 1,
    category: 'CONTRAVENTION',
    title: `Contravention code ${content.code}`,
    jurisdiction: 'ENGLAND_LONDON',
    authorityId: null,
    noticeType: null,
    proceduralStage: null,
    sourceName: 'National list of parking contravention codes used by London enforcement authorities',
    sourceLocation: 'https://www.londoncouncils.gov.uk/services/parking-services/parking-and-traffic/contravention-codes',
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
    reviewedAt: null,
    reviewStatus: 'PENDING_LEGAL_REVIEW',
    summary: content.plainEnglish,
    content: content as unknown as Record<string, unknown>,
  };
}

export const CONTRAVENTION_RECORDS: readonly ReferenceRecord[] = [
  contravention({
    code: '01',
    officialDescription: 'Parked in a restricted street during prescribed hours',
    plainEnglish:
      'The authority says your vehicle was parked on a street with waiting restrictions — typically single or double yellow lines — during the hours those restrictions apply.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Were the yellow lines continuous and clearly visible at the location?',
      'Was a time plate present, and what hours did it show?',
      'Were you loading or unloading, and for how long?',
      'Were you dropping off or picking up a passenger?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'VEHICLE_POSITION', 'COUNCIL_PHOTOGRAPHS', 'LOADING_EVIDENCE'],
  }),
  contravention({
    code: '02',
    officialDescription:
      'Parked or loading/unloading in a restricted street where waiting and loading/unloading restrictions are in force',
    plainEnglish:
      'The authority says your vehicle was on a street where loading and unloading are also restricted, not just waiting.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Were kerb blips (short yellow marks on the kerb) present?',
      'Did the sign state the loading restriction hours?',
      'What activity was taking place at the vehicle?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'COUNCIL_PHOTOGRAPHS', 'LOADING_EVIDENCE'],
  }),
  contravention({
    code: '12',
    officialDescription:
      'Parked in a residents’ or shared use parking place or zone without a valid virtual permit or clearly displaying a valid physical permit or voucher or pay and display ticket issued for that place',
    plainEnglish:
      'The authority says you were in a residents’ or shared-use bay without a valid permit, voucher or ticket for that bay.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Did you hold a valid permit for that bay at that time?',
      'If the permit is virtual, was the correct registration linked to it?',
      'If physical, was it displayed and legible from outside the vehicle?',
      'Did you buy a pay-and-display ticket or pay by app instead?',
    ],
    relevantEvidence: ['PERMIT', 'PAYMENT_RECEIPT', 'PARKING_APP_RECEIPT', 'COUNCIL_PHOTOGRAPHS', 'PARKING_SIGN'],
  }),
  contravention({
    code: '21',
    officialDescription: 'Parked in a suspended bay/space or part of a suspended bay/space',
    plainEnglish:
      'The authority says the bay you parked in had been suspended, for example for works, an event or a skip.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Was a suspension notice displayed, and where exactly?',
      'When was the suspension notice put up relative to when you parked?',
      'Did the notice cover the whole bay or only part of it?',
      'Was the notice legible and undamaged?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'VEHICLE_POSITION', 'COUNCIL_PHOTOGRAPHS', 'OTHER'],
  }),
  contravention({
    code: '23',
    officialDescription:
      'Parked in a parking place or area not designated for that class of vehicle',
    plainEnglish:
      'The authority says the bay was reserved for a different class of vehicle from yours — for example a motorcycle bay, a car club bay or a goods vehicle bay.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'What class of vehicle did the signs and bay markings specify?',
      'What class is your vehicle?',
      'Was the bay marking legible?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'VEHICLE_POSITION', 'COUNCIL_PHOTOGRAPHS'],
  }),
  contravention({
    code: '24',
    officialDescription: 'Not parked correctly within the markings of the bay or space',
    plainEnglish:
      'The authority says your vehicle was not properly inside the marked bay.',
    enforcementType: 'PARKING',
    penaltyBand: 'LOWER',
    commonFactualQuestions: [
      'Were the bay markings complete and visible, or worn away?',
      'How much of the vehicle was outside the bay?',
      'Was another vehicle or an obstruction preventing correct parking?',
    ],
    relevantEvidence: ['ROAD_MARKINGS', 'VEHICLE_POSITION', 'COUNCIL_PHOTOGRAPHS'],
  }),
  contravention({
    code: '30',
    officialDescription: 'Parked for longer than permitted',
    plainEnglish:
      'The authority says you stayed beyond the maximum time allowed in that bay or zone.',
    enforcementType: 'PARKING',
    penaltyBand: 'LOWER',
    commonFactualQuestions: [
      'What maximum stay did the sign state?',
      'What times do your payment or app records show?',
      'What observation times are shown on the notice?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'PAYMENT_RECEIPT', 'PARKING_APP_RECEIPT', 'COUNCIL_PHOTOGRAPHS'],
  }),
  contravention({
    code: '40',
    officialDescription:
      'Parked in a designated disabled person’s parking place without displaying a valid disabled person’s badge in the prescribed manner',
    plainEnglish:
      'The authority says you used a disabled bay without a valid Blue Badge displayed as required.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Was a valid Blue Badge held at the time?',
      'Was it displayed face up on the dashboard, with the clock set if required?',
      'Was the badge obscured by anything?',
    ],
    relevantEvidence: ['BLUE_BADGE', 'COUNCIL_PHOTOGRAPHS', 'VEHICLE_POSITION'],
  }),
  contravention({
    code: '45',
    officialDescription: 'Parked on a taxi rank',
    plainEnglish: 'The authority says your vehicle was on a marked taxi rank.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Were the rank markings and sign present and legible?',
      'Did the rank operate at restricted hours only?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'COUNCIL_PHOTOGRAPHS'],
  }),
  contravention({
    code: '46',
    officialDescription: 'Stopped where prohibited (on a red route or clearway)',
    plainEnglish:
      'The authority says you stopped where stopping is not allowed at all, such as a red route.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'How long was the vehicle stationary?',
      'Was the stop forced by traffic, a breakdown or an emergency?',
      'Were red route signs and markings present?',
    ],
    relevantEvidence: ['PARKING_SIGN', 'ROAD_MARKINGS', 'COUNCIL_PHOTOGRAPHS', 'BREAKDOWN_EVIDENCE'],
  }),
  contravention({
    code: '47',
    officialDescription: 'Stopped on a restricted bus stop or stand',
    plainEnglish:
      'The authority says your vehicle stopped in a bus stop clearway during its hours of operation.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Were the bus stop cage markings complete and visible?',
      'What hours did the sign show?',
      'How long was the vehicle stationary, and why?',
    ],
    relevantEvidence: ['ROAD_MARKINGS', 'PARKING_SIGN', 'COUNCIL_PHOTOGRAPHS', 'VEHICLE_POSITION'],
  }),
  contravention({
    code: '99',
    officialDescription:
      'Stopped on a pedestrian crossing and/or crossing area marked by zig-zags',
    plainEnglish:
      'The authority says your vehicle stopped on or within the zig-zag markings of a pedestrian crossing.',
    enforcementType: 'PARKING',
    penaltyBand: 'HIGHER',
    commonFactualQuestions: [
      'Were the zig-zag markings complete?',
      'Was the vehicle stationary in moving traffic rather than parked?',
    ],
    relevantEvidence: ['ROAD_MARKINGS', 'VEHICLE_POSITION', 'COUNCIL_PHOTOGRAPHS'],
  }),
];
