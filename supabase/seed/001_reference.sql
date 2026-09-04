-- Seed: authorities, products and the Camden data source.
--
-- Idempotent. Safe to re-run; existing rows are updated rather than duplicated.
--
-- `map_coverage_status = 'LIVE'` for Camden is NOT sufficient for the UI to claim
-- coverage. The coverage service additionally requires a successful ingestion run
-- and a minimum event count, so setting LIVE here makes the map show nothing until
-- data actually exists.

insert into authorities (slug, name, website_url, challenge_info_url, payment_info_url, tribunal_route, map_coverage_status, coverage_notes)
values
  ('camden', 'London Borough of Camden', 'https://www.camden.gov.uk',
   'https://www.camden.gov.uk/challenge-a-penalty-charge-notice',
   'https://www.camden.gov.uk/pay-a-penalty-charge-notice',
   'London Tribunals — Environment and Traffic Adjudicators', 'LIVE',
   'Enforcement map data is ingested from Camden''s published PCN dataset.'),
  ('islington', 'London Borough of Islington', 'https://www.islington.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('hackney', 'London Borough of Hackney', 'https://hackney.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('westminster', 'Westminster City Council', 'https://www.westminster.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('lambeth', 'London Borough of Lambeth', 'https://www.lambeth.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('southwark', 'London Borough of Southwark', 'https://www.southwark.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('tower-hamlets', 'London Borough of Tower Hamlets', 'https://www.towerhamlets.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('haringey', 'London Borough of Haringey', 'https://www.haringey.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('brent', 'London Borough of Brent', 'https://www.brent.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('newham', 'London Borough of Newham', 'https://www.newham.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('lewisham', 'London Borough of Lewisham', 'https://lewisham.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('wandsworth', 'London Borough of Wandsworth', 'https://www.wandsworth.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('hammersmith-fulham', 'London Borough of Hammersmith & Fulham', 'https://www.lbhf.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('kensington-chelsea', 'Royal Borough of Kensington and Chelsea', 'https://www.rbkc.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('ealing', 'London Borough of Ealing', 'https://www.ealing.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', ''),
  ('waltham-forest', 'London Borough of Waltham Forest', 'https://www.walthamforest.gov.uk', null, null,
   'London Tribunals — Environment and Traffic Adjudicators', 'UNAVAILABLE', '')
on conflict (slug) do update set
  name = excluded.name,
  website_url = excluded.website_url,
  challenge_info_url = excluded.challenge_info_url,
  payment_info_url = excluded.payment_info_url,
  tribunal_route = excluded.tribunal_route,
  map_coverage_status = excluded.map_coverage_status,
  coverage_notes = excluded.coverage_notes;

-- Products. Prices mirror src/server/payments/catalogue.ts, which is the source of
-- truth for what is charged. This table exists so a payment row can reference a
-- product; a mismatch between the two is caught by the webhook's amount check.
insert into products (sku, name, description, price_pence, currency, entitlements, active)
values
  ('FINE_RADAR_DEFENCE', 'Defence Pack',
   'The full analysis of your notice, with an editable challenge you can send yourself.',
   599, 'GBP',
   array['DETAILED_ASSESSMENT','EVIDENCE_GAP_ANALYSIS','CHALLENGE_DRAFT','EXPORT_PDF'], true),
  ('FINE_RADAR_REJECTION_REVIEW', 'Rejection Review',
   'For when the authority has rejected your representations and you need to know what it actually addressed.',
   499, 'GBP',
   array['REJECTION_COMPARISON','EXPORT_PDF'], true),
  ('FINE_RADAR_APPEAL_PACK', 'Appeal Pack',
   'Everything above, prepared for an appeal to the independent adjudicator.',
   999, 'GBP',
   array['DETAILED_ASSESSMENT','EVIDENCE_GAP_ANALYSIS','CHALLENGE_DRAFT','REJECTION_COMPARISON','APPEAL_BUNDLE','EXPORT_PDF'], true)
on conflict (sku) do update set
  name = excluded.name,
  description = excluded.description,
  price_pence = excluded.price_pence,
  entitlements = excluded.entitlements,
  active = excluded.active;

-- The Camden source, so provenance exists before the first ingestion run.
insert into data_sources (slug, name, publisher, licence, licence_url, source_url, attribution_text, coverage_notes)
values (
  'camden-pcn',
  'Camden penalty charge notices',
  'London Borough of Camden',
  'Open Government Licence v3.0',
  'https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/',
  'https://opendata.camden.gov.uk/',
  'Contains public sector information from the London Borough of Camden licensed under the Open Government Licence v3.0.',
  'Penalty charge notices issued in the London Borough of Camden. Coverage is limited to what Camden publishes; it is not a complete record of all enforcement activity.'
)
on conflict (slug) do update set
  name = excluded.name,
  attribution_text = excluded.attribution_text,
  coverage_notes = excluded.coverage_notes;

insert into authority_data_sources (authority_id, source_id)
select a.id, s.id
from authorities a, data_sources s
where a.slug = 'camden' and s.slug = 'camden-pcn'
on conflict do nothing;
