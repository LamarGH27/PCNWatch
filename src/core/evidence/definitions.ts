import type { EvidenceDefinition, EvidenceType } from './types';

/**
 * Capture guidance is written for the mobile case: someone standing beside their
 * vehicle, one-handed, possibly in the rain. Short sentences, concrete actions.
 */
export const EVIDENCE_DEFINITIONS: Record<EvidenceType, EvidenceDefinition> = {
  PCN_IMAGE: {
    type: 'PCN_IMAGE',
    label: 'The penalty charge notice',
    howToCapture: 'Photograph the whole notice flat, all four corners visible, in good light.',
    whyItMatters: 'Every date, amount and code in your case is checked against this document.',
  },
  COUNCIL_PHOTOGRAPHS: {
    type: 'COUNCIL_PHOTOGRAPHS',
    label: 'The authority’s photographs',
    howToCapture:
      'Most London authorities publish the enforcement photos online using your PCN number and vehicle registration. Download them and upload them here.',
    whyItMatters:
      'These are the images the authority will rely on. Reviewing them early tells you what you are actually arguing against.',
  },
  PARKING_SIGN: {
    type: 'PARKING_SIGN',
    label: 'Signs at the location',
    howToCapture:
      'Photograph the nearest sign close up so the text is readable, then step back and take a second photo showing the sign and your parking space together.',
    whyItMatters:
      'A restriction has to be signed. What the sign says, and whether it can be seen from where you parked, is often the whole case.',
  },
  ROAD_MARKINGS: {
    type: 'ROAD_MARKINGS',
    label: 'Road markings and bay lines',
    howToCapture:
      'Photograph the lines on the road and the kerb next to your vehicle. Include any gaps, wear or missing markings.',
    whyItMatters: 'Worn, incomplete or absent markings can matter to whether a restriction is enforceable.',
  },
  VEHICLE_POSITION: {
    type: 'VEHICLE_POSITION',
    label: 'Where your vehicle was',
    howToCapture:
      'Take one photo from the front and one from the back, far enough away to show the vehicle, the bay and the nearest signs together.',
    whyItMatters: 'Shows the position the authority is describing, from your point of view.',
  },
  PAYMENT_RECEIPT: {
    type: 'PAYMENT_RECEIPT',
    label: 'Payment receipt',
    howToCapture: 'Photograph the ticket, or screenshot the card or bank transaction showing time and amount.',
    whyItMatters: 'Direct evidence of what you paid and when.',
  },
  PARKING_APP_RECEIPT: {
    type: 'PARKING_APP_RECEIPT',
    label: 'Parking app session',
    howToCapture:
      'Screenshot the session in your parking app showing the registration, location or zone number, start time and end time.',
    whyItMatters:
      'Shows the session you bought. The registration and zone shown must match the location on the notice.',
  },
  PERMIT: {
    type: 'PERMIT',
    label: 'Parking permit',
    howToCapture:
      'Photograph the permit, or screenshot the account page showing the permit, the vehicle registration and the valid dates.',
    whyItMatters: 'Establishes that you were entitled to park in that bay at that time.',
  },
  BLUE_BADGE: {
    type: 'BLUE_BADGE',
    label: 'Blue Badge',
    howToCapture:
      'Photograph both sides of the badge, and a photo showing how it was displayed on the dashboard if you can.',
    whyItMatters: 'Shows the badge was valid and how it was displayed.',
  },
  LOADING_EVIDENCE: {
    type: 'LOADING_EVIDENCE',
    label: 'Loading or unloading evidence',
    howToCapture:
      'Collect delivery notes, invoices, timestamped photos of goods, or a signed statement from the person receiving them.',
    whyItMatters: 'Loading is a question of fact — what was moved, where to, and over what period.',
  },
  WITNESS_INFORMATION: {
    type: 'WITNESS_INFORMATION',
    label: 'Witness details',
    howToCapture: 'Write down what the person saw, when, and their contact details, and ask them to sign it.',
    whyItMatters: 'An independent account of what happened at the time.',
  },
  BREAKDOWN_EVIDENCE: {
    type: 'BREAKDOWN_EVIDENCE',
    label: 'Breakdown or recovery evidence',
    howToCapture: 'Upload the recovery job sheet, garage invoice or breakdown provider confirmation with times.',
    whyItMatters: 'Shows the vehicle could not be moved and for how long.',
  },
  CORRESPONDENCE: {
    type: 'CORRESPONDENCE',
    label: 'Correspondence with the authority',
    howToCapture: 'Upload every letter or email, including the ones you sent, with their dates.',
    whyItMatters: 'Establishes what was said, by whom, and when — which drives your deadlines.',
  },
  OTHER: {
    type: 'OTHER',
    label: 'Other evidence',
    howToCapture: 'Upload anything else relevant and describe what it shows.',
    whyItMatters: 'Some cases turn on something specific to your circumstances.',
  },
};
