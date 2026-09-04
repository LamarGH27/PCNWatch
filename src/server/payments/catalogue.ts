/**
 * Product catalogue.
 *
 * Prices live here and nowhere else. A price is never written inline in a page,
 * an API route or a Stripe call — the checkout reads the amount from this table,
 * and the webhook validates the amount paid against it.
 *
 * Changing a price is a one-line change here plus a new Stripe Price id.
 */

export type ProductSku =
  | 'FINE_RADAR_DEFENCE'
  | 'FINE_RADAR_REJECTION_REVIEW'
  | 'FINE_RADAR_APPEAL_PACK';

export type Entitlement =
  | 'DETAILED_ASSESSMENT'
  | 'EVIDENCE_GAP_ANALYSIS'
  | 'CHALLENGE_DRAFT'
  | 'EXPORT_PDF'
  | 'REJECTION_COMPARISON'
  | 'APPEAL_BUNDLE';

export interface Product {
  readonly sku: ProductSku;
  readonly name: string;
  readonly description: string;
  readonly pricePence: number;
  readonly currency: 'GBP';
  /** What the purchase unlocks. Checked server-side before any gated work runs. */
  readonly entitlements: readonly Entitlement[];
  /** Bullet points shown on the pricing card. */
  readonly includes: readonly string[];
  /** Env var holding the Stripe Price id. Absent means checkout is unavailable. */
  readonly stripePriceEnvKey: string;
}

export const PRODUCTS: readonly Product[] = [
  {
    sku: 'FINE_RADAR_DEFENCE',
    name: 'Defence Pack',
    description:
      'The full analysis of your notice, with an editable challenge you can send yourself.',
    pricePence: 599,
    currency: 'GBP',
    entitlements: ['DETAILED_ASSESSMENT', 'EVIDENCE_GAP_ANALYSIS', 'CHALLENGE_DRAFT', 'EXPORT_PDF'],
    includes: [
      'Detailed assessment with structured findings',
      'Evidence gap analysis',
      'Editable challenge draft',
      'PDF export of your defence material',
    ],
    stripePriceEnvKey: 'STRIPE_PRICE_DEFENCE',
  },
  {
    sku: 'FINE_RADAR_REJECTION_REVIEW',
    name: 'Rejection Review',
    description:
      'For when the authority has rejected your representations and you need to know what it actually addressed.',
    pricePence: 499,
    currency: 'GBP',
    entitlements: ['REJECTION_COMPARISON', 'EXPORT_PDF'],
    includes: [
      'Classification of the rejection reasoning',
      'Comparison against what you submitted',
      'Which arguments and evidence appear unaddressed',
      'Your appeal deadline and next procedural option',
    ],
    stripePriceEnvKey: 'STRIPE_PRICE_REJECTION_REVIEW',
  },
  {
    sku: 'FINE_RADAR_APPEAL_PACK',
    name: 'Appeal Pack',
    description: 'Everything above, prepared for an appeal to the independent adjudicator.',
    pricePence: 999,
    currency: 'GBP',
    entitlements: [
      'DETAILED_ASSESSMENT',
      'EVIDENCE_GAP_ANALYSIS',
      'CHALLENGE_DRAFT',
      'REJECTION_COMPARISON',
      'APPEAL_BUNDLE',
      'EXPORT_PDF',
    ],
    includes: [
      'Everything in the Defence Pack and Rejection Review',
      'Appeal submission document',
      'Indexed evidence bundle',
      'You submit the appeal yourself — FineRadar never submits on your behalf',
    ],
    stripePriceEnvKey: 'STRIPE_PRICE_APPEAL_PACK',
  },
];

export function getProduct(sku: string): Product | undefined {
  return PRODUCTS.find((p) => p.sku === sku);
}

/** Every entitlement granted by a set of purchased SKUs. */
export function entitlementsFor(skus: readonly string[]): Set<Entitlement> {
  const granted = new Set<Entitlement>();
  for (const sku of skus) {
    const product = getProduct(sku);
    if (!product) continue;
    for (const entitlement of product.entitlements) granted.add(entitlement);
  }
  return granted;
}

/**
 * Free-tier capabilities. Anything not listed here requires an entitlement.
 * Kept beside the paid catalogue so the boundary is visible in one place.
 */
export const FREE_CAPABILITIES = [
  'MAP',
  'HOTSPOTS',
  'PCN_EXTRACTION',
  'CONTRAVENTION_EXPLANATION',
  'BASIC_EVIDENCE_CHECKLIST',
  'DEADLINE_TRACKING',
] as const;
