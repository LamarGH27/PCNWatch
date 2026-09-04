/**
 * London authority directory.
 *
 * A configuration table rather than markup, so adding an authority is a data
 * change. `mapCoverage` describes the *enforcement map* only — PCN analysis works
 * for any London local-authority notice regardless of what this says.
 *
 * `reviewedAt: null` means nobody has verified these links recently; the UI says
 * so rather than presenting stale links as checked.
 */

export interface AuthorityRecord {
  readonly slug: string;
  readonly name: string;
  readonly websiteUrl: string;
  readonly challengeInfoUrl: string | null;
  readonly paymentInfoUrl: string | null;
  readonly tribunalRoute: string;
  readonly mapCoverage: 'LIVE' | 'PLANNED' | 'UNAVAILABLE';
  readonly dataSources: readonly string[];
  readonly reviewedAt: string | null;
}

const TRIBUNAL_LONDON = 'London Tribunals — Environment and Traffic Adjudicators';

function borough(
  slug: string,
  name: string,
  domain: string,
  overrides: Partial<AuthorityRecord> = {},
): AuthorityRecord {
  return {
    slug,
    name,
    websiteUrl: `https://${domain}`,
    challengeInfoUrl: null,
    paymentInfoUrl: null,
    tribunalRoute: TRIBUNAL_LONDON,
    mapCoverage: 'UNAVAILABLE',
    dataSources: [],
    reviewedAt: null,
    ...overrides,
  };
}

export const LONDON_AUTHORITIES: readonly AuthorityRecord[] = [
  borough('camden', 'London Borough of Camden', 'www.camden.gov.uk', {
    challengeInfoUrl: 'https://www.camden.gov.uk/challenge-a-penalty-charge-notice',
    paymentInfoUrl: 'https://www.camden.gov.uk/pay-a-penalty-charge-notice',
    mapCoverage: 'LIVE',
    dataSources: ['camden-pcn'],
  }),
  borough('islington', 'London Borough of Islington', 'www.islington.gov.uk'),
  borough('hackney', 'London Borough of Hackney', 'hackney.gov.uk'),
  borough('westminster', 'Westminster City Council', 'www.westminster.gov.uk'),
  borough('lambeth', 'London Borough of Lambeth', 'www.lambeth.gov.uk'),
  borough('southwark', 'London Borough of Southwark', 'www.southwark.gov.uk'),
  borough('tower-hamlets', 'London Borough of Tower Hamlets', 'www.towerhamlets.gov.uk'),
  borough('haringey', 'London Borough of Haringey', 'www.haringey.gov.uk'),
  borough('brent', 'London Borough of Brent', 'www.brent.gov.uk'),
  borough('newham', 'London Borough of Newham', 'www.newham.gov.uk'),
  borough('lewisham', 'London Borough of Lewisham', 'lewisham.gov.uk'),
  borough('wandsworth', 'London Borough of Wandsworth', 'www.wandsworth.gov.uk'),
  borough('hammersmith-fulham', 'London Borough of Hammersmith & Fulham', 'www.lbhf.gov.uk'),
  borough('kensington-chelsea', 'Royal Borough of Kensington and Chelsea', 'www.rbkc.gov.uk'),
  borough('ealing', 'London Borough of Ealing', 'www.ealing.gov.uk'),
  borough('waltham-forest', 'London Borough of Waltham Forest', 'www.walthamforest.gov.uk'),
];

export function getAuthorityRecord(slug: string): AuthorityRecord | undefined {
  return LONDON_AUTHORITIES.find((a) => a.slug === slug);
}
