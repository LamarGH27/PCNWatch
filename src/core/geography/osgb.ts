/**
 * British National Grid (EPSG:27700) to WGS84.
 *
 * Ordnance Survey's open products publish eastings and northings on the Airy
 * 1830 ellipsoid; the map draws WGS84. Converting is not optional and not a
 * rounding detail — treating a BNG easting as a longitude puts the point in the
 * Atlantic, and a plausible-looking but wrong transform puts it a hundred
 * metres down the road, which nothing downstream would catch.
 *
 * Implemented here rather than pulled in: it is the standard OS transformation,
 * it is fully specified in their own guide, and it must not change under us.
 *
 * Accuracy: the Helmert transformation is good to roughly ±5 m, which is well
 * inside the precision this product claims. A gazetteer point is a label
 * position for a whole road; the transform is not the limiting factor.
 */

export interface LatLon {
  readonly longitude: number;
  readonly latitude: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

// Airy 1830, the ellipsoid the National Grid is projected on.
const AIRY_A = 6377563.396;
const AIRY_B = 6356256.909;
// Transverse Mercator parameters for the National Grid.
const F0 = 0.9996012717;
const LAT0 = rad(49);
const LON0 = rad(-2);
const E0 = 400000;
const N0 = -100000;

// Helmert, OSGB36 -> WGS84.
const TX = 446.448;
const TY = -125.157;
const TZ = 542.06;
const RX = rad(0.1502 / 3600);
const RY = rad(0.247 / 3600);
const RZ = rad(0.8421 / 3600);
const SCALE = -20.4894e-6;

/** Converts an easting/northing to longitude and latitude. */
export function bngToWgs84(easting: number, northing: number): LatLon {
  const e2 = 1 - (AIRY_B * AIRY_B) / (AIRY_A * AIRY_A);
  const n = (AIRY_A - AIRY_B) / (AIRY_A + AIRY_B);

  // Reverse the projection to a latitude on Airy 1830.
  let lat = LAT0;
  let M = 0;
  do {
    lat = (northing - N0 - M) / (AIRY_A * F0) + lat;
    const dLat = lat - LAT0;
    const sLat = lat + LAT0;
    const Ma = (1 + n + 1.25 * n * n + 1.25 * n ** 3) * dLat;
    const Mb = (3 * n + 3 * n * n + 2.625 * n ** 3) * Math.sin(dLat) * Math.cos(sLat);
    const Mc = (1.875 * n * n + 1.875 * n ** 3) * Math.sin(2 * dLat) * Math.cos(2 * sLat);
    const Md = (35 / 24) * n ** 3 * Math.sin(3 * dLat) * Math.cos(3 * sLat);
    M = AIRY_B * F0 * (Ma - Mb + Mc - Md);
  } while (Math.abs(northing - N0 - M) >= 0.00001);

  const sin = Math.sin(lat);
  const cos = Math.cos(lat);
  const tan = Math.tan(lat);
  const nu = (AIRY_A * F0) / Math.sqrt(1 - e2 * sin * sin);
  const rho = (AIRY_A * F0 * (1 - e2)) / Math.pow(1 - e2 * sin * sin, 1.5);
  const eta2 = nu / rho - 1;

  const t2 = tan * tan;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const VII = tan / (2 * rho * nu);
  const VIII = (tan / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tan / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = 1 / (cos * nu);
  const XI = (1 / (6 * cos * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (1 / (120 * cos * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (1 / (5040 * cos * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  const dE = easting - E0;
  const latAiry = lat - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lonAiry = LON0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  // Airy 1830 geodetic -> cartesian, Helmert to WGS84, back to geodetic.
  const sinA = Math.sin(latAiry);
  const cosA = Math.cos(latAiry);
  const nuA = AIRY_A / Math.sqrt(1 - e2 * sinA * sinA);
  const x1 = nuA * cosA * Math.cos(lonAiry);
  const y1 = nuA * cosA * Math.sin(lonAiry);
  const z1 = (1 - e2) * nuA * sinA;

  const s = 1 + SCALE;
  const x2 = TX + s * x1 - RZ * y1 + RY * z1;
  const y2 = TY + RZ * x1 + s * y1 - RX * z1;
  const z2 = TZ - RY * x1 + RX * y1 + s * z1;

  const wa = 6378137.0;
  const wb = 6356752.3142;
  const we2 = 1 - (wb * wb) / (wa * wa);
  const p = Math.sqrt(x2 * x2 + y2 * y2);
  let phi = Math.atan2(z2, p * (1 - we2));
  let prev = 2 * Math.PI;
  let iterations = 0;
  while (Math.abs(phi - prev) > 1e-12 && iterations < 100) {
    const nuW = wa / Math.sqrt(1 - we2 * Math.sin(phi) ** 2);
    prev = phi;
    phi = Math.atan2(z2 + we2 * nuW * Math.sin(phi), p);
    iterations += 1;
  }

  return { longitude: deg(Math.atan2(y2, x2)), latitude: deg(phi) };
}
