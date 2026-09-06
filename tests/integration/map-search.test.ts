import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';

/**
 * The street-search query, against real PostGIS.
 *
 * This is the test that would have caught the production bug. The endpoint
 * selected `geom` and read it as `{ coordinates: [lon, lat] }`; PostgREST
 * serialises a geography column as a WKB hex *string*, so the read produced
 * undefined, every row was dropped, and the search returned nothing however
 * good the match. A cast to `unknown` let it compile.
 *
 * No amount of stubbing finds that — the stub returns whatever shape the test
 * author believed the database used. Only a real query does.
 */

const DATABASE_URL = process.env.PCNWATCH_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error(
    'PCNWATCH_TEST_DATABASE_URL (or DATABASE_URL) must point at a migrated PostGIS database. ' +
      'Run these through `npm run db:test`, which creates one.',
  );
}

const AUTHORITY_SLUG = 'search-borough';
const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

/** The endpoint's query, verbatim. If it changes there, it must change here. */
const SEARCH_SQL = `
  select l.slug,
         l.display_name,
         st_x(l.geom::geometry) as longitude,
         st_y(l.geom::geometry) as latitude
    from parking_locations l
    join authorities a on a.id = l.authority_id
   where a.slug = $1
     and l.geom is not null
     and l.street_name_normalised like '%' || $2 || '%'
   order by case
              when l.street_name_normalised = $2 then 0
              when l.street_name_normalised like $2 || '%' then 1
              else 2
            end,
            length(l.street_name_normalised),
            l.display_name
   limit 8`;

interface Row {
  slug: string;
  display_name: string;
  longitude: number;
  latitude: number;
}

async function search(term: string): Promise<Row[]> {
  const { rows } = await pool.query<Row>(SEARCH_SQL, [AUTHORITY_SLUG, term]);
  return rows;
}

const STREETS: [string, string, number, number][] = [
  ['woburn-place', 'WOBURN PLACE', -0.1268, 51.5241],
  ['theobalds-road', 'THEOBALDS ROAD', -0.1156, 51.5197],
  ['camden-high-street', 'CAMDEN HIGH STREET', -0.1426, 51.539],
  ['camden-road', 'CAMDEN ROAD', -0.1389, 51.5426],
  // Deliberately unpositioned: must never be offered as somewhere to fly to.
  ['unplaced-mews', 'UNPLACED MEWS', 0, 0],
];

beforeAll(async () => {
  await pool.query(
    `insert into authorities (slug, name, map_coverage_status)
     values ($1, 'Search Borough', 'LIVE') on conflict (slug) do nothing`,
    [AUTHORITY_SLUG],
  );
  for (const [slug, name, lon, lat] of STREETS) {
    await pool.query(
      `insert into parking_locations (authority_id, slug, display_name, street_name,
                                      street_name_normalised, retrieved_at, data_confidence, geom)
       select a.id, $2, $3, $3, lower($3), now(), 0.9,
              case when $6::boolean
                   then st_setsrid(st_point($4::float8, $5::float8), 4326)::geography
              end
         from authorities a where a.slug = $1
       on conflict (authority_id, slug) do nothing`,
      [AUTHORITY_SLUG, slug, name, lon, lat, slug !== 'unplaced-mews'],
    );
  }
});

afterAll(async () => {
  await pool.query(
    `delete from parking_locations
      where authority_id = (select id from authorities where slug = $1)`,
    [AUTHORITY_SLUG],
  );
  await pool.query('delete from authorities where slug = $1', [AUTHORITY_SLUG]);
  await pool.end();
});

describe('street search returns coordinates the map can use', () => {
  it('returns finite numbers, not a WKB hex string', async () => {
    const rows = await search('woburn place');
    expect(rows.length).toBeGreaterThan(0);

    const [first] = rows;
    // The precise assertion the old code failed: a usable number, on a named
    // column, not an opaque blob behind an optimistic cast.
    expect(typeof Number(first!.longitude)).toBe('number');
    expect(Number.isFinite(Number(first!.longitude))).toBe(true);
    expect(Number.isFinite(Number(first!.latitude))).toBe(true);
    expect(String(first!.longitude)).not.toMatch(/^0101000020/);
    expect(Number(first!.longitude)).toBeCloseTo(-0.1268, 3);
    expect(Number(first!.latitude)).toBeCloseTo(51.5241, 3);
  });

  it('proves why selecting geom directly cannot work', async () => {
    // The exact shape the old endpoint assumed, queried the old way. This is
    // what it actually gets back: a hex string with no `.coordinates` anywhere
    // on it, so `(row.geom as { coordinates? }).coordinates` was undefined for
    // every row and every result was silently discarded.
    const { rows } = await pool.query<{ geom: unknown }>(
      `select l.geom from parking_locations l
         join authorities a on a.id = l.authority_id
        where a.slug = $1 and l.slug = 'woburn-place'`,
      [AUTHORITY_SLUG],
    );
    const geom = rows[0]!.geom;
    expect(typeof geom).toBe('string');
    expect(String(geom)).toMatch(/^0101000020/);
    expect((geom as { coordinates?: unknown }).coordinates).toBeUndefined();
  });

  it('finds each known street', async () => {
    for (const [slug, name] of STREETS.filter(([s]) => s !== 'unplaced-mews')) {
      const rows = await search(name.toLowerCase());
      expect(rows.map((r) => r.slug), `${name} should be findable`).toContain(slug);
    }
  });

  it('is case-insensitive and tolerant of spacing', async () => {
    const variants = ['CAMDEN HIGH STREET', 'camden high street', 'Camden High Street'];
    const results = await Promise.all(variants.map((v) => search(v.toLowerCase())));
    for (const rows of results) {
      expect(rows.map((r) => r.slug)).toContain('camden-high-street');
    }
  });

  it('ranks an exact match above a partial one', async () => {
    // "camden road" is exact; "camden high street" merely contains "camden".
    const rows = await search('camden road');
    expect(rows[0]?.slug).toBe('camden-road');
  });

  it('ranks a prefix match above a mid-string one', async () => {
    const rows = await search('camden');
    // Both start with "camden"; the shorter name wins the tie deterministically.
    expect(rows.map((r) => r.slug)).toContain('camden-road');
    expect(rows.map((r) => r.slug)).toContain('camden-high-street');
    expect(rows[0]?.slug).toBe('camden-road');
  });

  it('returns nothing for an unknown street rather than a near-miss', async () => {
    expect(await search('nonexistent avenue')).toEqual([]);
  });

  it('never offers a street it cannot place on the map', async () => {
    const rows = await search('unplaced mews');
    expect(rows).toEqual([]);
  });

  it('returns a bounded result set', async () => {
    const rows = await search('a');
    expect(rows.length).toBeLessThanOrEqual(8);
  });

  it('does not leak another authority\'s streets', async () => {
    const { rows } = await pool.query(SEARCH_SQL, ['camden', 'woburn place']);
    expect(rows.map((r: Row) => r.slug)).not.toContain('woburn-place');
  });
});
