/**
 * A fictional penalty charge notice, for testing the reader.
 *
 * Every value here is invented. The authority does not exist, the registration
 * is not a real vehicle, and the PCN number belongs to nothing. That is the
 * point: the first end-to-end run of a document reader must not be somebody's
 * actual notice, which carries their name, address, registration and location.
 *
 * The values are chosen to exercise the parts that go wrong rather than to be
 * easy: a contravention code Camden really issues, a date late enough in the
 * month to be ambiguous under a US reading, an amount with a discount, and a
 * printed deadline the model must copy rather than compute.
 */

export const SYNTHETIC_PCN = {
  authorityName: 'London Borough of Testbury',
  pcnNumber: 'TB99887766',
  vehicleRegistration: 'TE57 XYZ',
  noticeType: 'PCN_POSTAL' as const,
  contraventionCode: '12',
  contraventionDescription: "Parked in a residents' bay without a valid permit",
  incidentDate: '2026-08-11',
  incidentTime: '14:35',
  issueDate: '2026-08-14',
  location: 'EVERSHOLT STREET NW1',
  fullAmountPence: 13_000,
  discountedAmountPence: 6_500,
  discountDeadlinePrinted: '2026-08-28',
  representationDeadlinePrinted: '2026-09-11',
} as const;

/**
 * The notice as it appears on paper.
 *
 * Laid out the way a real postal PCN is — headings, a details table, the
 * payment box, the challenge paragraph — because a reader that only works on a
 * tidy list of key-value pairs has not been tested on anything.
 */
export const SYNTHETIC_PCN_TEXT = `
LONDON BOROUGH OF TESTBURY
Parking Services, PO Box 4412, Testbury TB1 9ZZ

PENALTY CHARGE NOTICE
Served by post under the Traffic Management Act 2004

Penalty Charge Notice Number:   ${SYNTHETIC_PCN.pcnNumber}
Vehicle Registration Mark:      ${SYNTHETIC_PCN.vehicleRegistration}
Date of Contravention:          11 August 2026
Time of Contravention:          14:35
Location of Contravention:      ${SYNTHETIC_PCN.location}
Contravention Code:             ${SYNTHETIC_PCN.contraventionCode}
Contravention:                  ${SYNTHETIC_PCN.contraventionDescription}
Date of Notice:                 14 August 2026

AMOUNT PAYABLE
The penalty charge is £130.00.
If payment is received on or before 28 August 2026 the charge is
reduced to £65.00.

MAKING REPRESENTATIONS
If you believe this penalty charge should not have been issued you may
make representations to the Council. Representations must be received
by 11 September 2026.

This notice does not constitute legal advice.
`.trim();

/** Marks any artefact built from this fixture, so it cannot be mistaken for real. */
export const SYNTHETIC_MARKER = 'SYNTHETIC TEST NOTICE — NOT A REAL PENALTY CHARGE';
