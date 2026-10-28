// Ellipsoid measures for the editing canvas: geodesics on WGS84
// (Vincenty's direct and inverse solutions) and the two numbers that
// relate a projected grid to the ground at a point, the grid
// convergence and the point scale factor. No DOM; tested under node.
//
// Vincenty's inverse fails to converge for nearly antipodal points; a
// canvas edits places, not hemispheres, so that is reported, not solved.

const A = 6378137, F = 1 / 298.257223563, B = A * (1 - F);
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

// Distance (metres) and forward azimuths (degrees clockwise from north)
// between two lon/lat points; null if it does not converge.
export function inverse(lon1, lat1, lon2, lat2) {
  const L = rad(lon2 - lon1);
  const U1 = Math.atan((1 - F) * Math.tan(rad(lat1)));
  const U2 = Math.atan((1 - F) * Math.tan(rad(lat2)));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1), sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = L, lamP, sS, cS, sig, sA, c2A, c2Sm, it = 0;
  do {
    const sL = Math.sin(lam), cL = Math.cos(lam);
    sS = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
    if (sS === 0) return { s: 0, az1: 0, az2: 0 };
    cS = sU1 * sU2 + cU1 * cU2 * cL;
    sig = Math.atan2(sS, cS);
    sA = (cU1 * cU2 * sL) / sS;
    c2A = 1 - sA * sA;
    c2Sm = c2A !== 0 ? cS - (2 * sU1 * sU2) / c2A : 0;
    const C = (F / 16) * c2A * (4 + F * (4 - 3 * c2A));
    lamP = lam;
    lam = L + (1 - C) * F * sA * (sig + C * sS * (c2Sm + C * cS * (-1 + 2 * c2Sm * c2Sm)));
  } while (Math.abs(lam - lamP) > 1e-12 && ++it < 200);
  if (it >= 200) return null;
  const u2 = (c2A * (A * A - B * B)) / (B * B);
  const kA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const kB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  const dS = kB * sS * (c2Sm + (kB / 4) * (cS * (-1 + 2 * c2Sm * c2Sm) - (kB / 6) * c2Sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2Sm * c2Sm)));
  const s = B * kA * (sig - dS);
  const sL = Math.sin(lam), cL = Math.cos(lam);
  const az1 = Math.atan2(cU2 * sL, cU1 * sU2 - sU1 * cU2 * cL);
  const az2 = Math.atan2(cU1 * sL, -sU1 * cU2 + cU1 * sU2 * cL);
  return { s, az1: norm360(deg(az1)), az2: norm360(deg(az2)) };
}

// The point s metres from lon/lat along azimuth az (degrees from north).
export function direct(lon1, lat1, az, s) {
  const a1 = rad(az);
  const sa1 = Math.sin(a1), ca1 = Math.cos(a1);
  const tU1 = (1 - F) * Math.tan(rad(lat1));
  const cU1 = 1 / Math.sqrt(1 + tU1 * tU1), sU1 = tU1 * cU1;
  const sig1 = Math.atan2(tU1, ca1);
  const sA = cU1 * sa1, c2A = 1 - sA * sA;
  const u2 = (c2A * (A * A - B * B)) / (B * B);
  const kA = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
  const kB = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
  let sig = s / (B * kA), sigP, c2Sm, sS, cS, it = 0;
  do {
    c2Sm = Math.cos(2 * sig1 + sig);
    sS = Math.sin(sig); cS = Math.cos(sig);
    const dS = kB * sS * (c2Sm + (kB / 4) * (cS * (-1 + 2 * c2Sm * c2Sm) - (kB / 6) * c2Sm * (-3 + 4 * sS * sS) * (-3 + 4 * c2Sm * c2Sm)));
    sigP = sig;
    sig = s / (B * kA) + dS;
  } while (Math.abs(sig - sigP) > 1e-12 && ++it < 200);
  c2Sm = Math.cos(2 * sig1 + sig); sS = Math.sin(sig); cS = Math.cos(sig);
  const x = sU1 * sS - cU1 * cS * ca1;
  const lat2 = Math.atan2(sU1 * cS + cU1 * sS * ca1, (1 - F) * Math.sqrt(sA * sA + x * x));
  const lam = Math.atan2(sS * sa1, cU1 * cS - sU1 * sS * ca1);
  const C = (F / 16) * c2A * (4 + F * (4 - 3 * c2A));
  const L = lam - (1 - C) * F * sA * (sig + C * sS * (c2Sm + C * cS * (-1 + 2 * c2Sm * c2Sm)));
  return [lon1 + deg(L), deg(lat2)];
}

// Points along the geodesic from lon/lat p to q, n segments.
export function geodesicPoints(p, q, n) {
  const g = inverse(p[0], p[1], q[0], q[1]);
  if (!g || n < 2) return [p, q];
  const out = [p];
  for (let i = 1; i < n; i++) out.push(direct(p[0], p[1], g.az1, (g.s * i) / n));
  out.push(q);
  return out;
}

// A grid: functions from frame coordinates to lon/lat and back. The
// helpers below answer the surveyor's questions at a frame point p: which
// grid direction is a true azimuth, which true azimuth is a grid
// direction, how long on the ground is a grid length. They work by
// stepping a short way and measuring, so they hold for any projection.
const STEP = 1; // metres on the ground, frame units on the grid

export function makeGeo(toLL, fromLL) {
  const geo = {
    toLL, fromLL,
    // grid direction (math radians) of the true azimuth az (degrees) at p
    gridTheta(p, az) {
      const ll = toLL(p);
      const q = fromLL(direct(ll[0], ll[1], az, STEP));
      return Math.atan2(q[1] - p[1], q[0] - p[0]);
    },
    // true azimuth (degrees) of the grid direction theta at p
    trueAz(p, theta) {
      const a = toLL(p), b = toLL([p[0] + STEP * Math.cos(theta), p[1] + STEP * Math.sin(theta)]);
      const g = inverse(a[0], a[1], b[0], b[1]);
      return g ? g.az1 : NaN;
    },
    // point scale factor at p along theta: grid length per ground length
    scale(p, theta = 0) {
      const a = toLL(p), b = toLL([p[0] + STEP * Math.cos(theta), p[1] + STEP * Math.sin(theta)]);
      const g = inverse(a[0], a[1], b[0], b[1]);
      return g && g.s > 0 ? STEP / g.s : NaN;
    },
    // grid convergence at p, as surveyors sign it: the angle from true
    // north to grid north, degrees, clockwise positive (for transverse
    // Mercator about delta-longitude times sine of latitude)
    convergence(p) {
      const t = geo.gridTheta(p, 0); // true north, on the grid
      const b = 90 - deg(t);         // its grid bearing
      return -(((b + 180) % 360 + 360) % 360 - 180);
    },
    // ground distance between frame points
    distance(p, q) {
      const a = toLL(p), b = toLL(q);
      const g = inverse(a[0], a[1], b[0], b[1]);
      return g ? g.s : NaN;
    },
    // a geodesic edge drawn in the frame, densified so each piece spans
    // about maxLen frame units
    curve(p, q, maxLen) {
      const n = Math.min(256, Math.max(1, Math.ceil(Math.hypot(q[0] - p[0], q[1] - p[1]) / maxLen)));
      if (n < 2) return [p, q];
      const pts = geodesicPoints(toLL(p), toLL(q), n).map(fromLL);
      pts[0] = p; pts[pts.length - 1] = q;
      return pts;
    },
  };
  return geo;
}
