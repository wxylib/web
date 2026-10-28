// Field patterns for the editing canvas: parallel transects, transects
// filling a survey polygon, a lawnmower track through them, and a shape
// repeated along a direction. Lengths and spacings are metres on the
// ellipsoid and azimuths true when a geo (edit-geo.js makeGeo) is given,
// frame units and grid bearings otherwise. No DOM; tested under node.

import { direct, inverse } from "./edit-geo.js";
import { pointInRing } from "./edit-core.js";

const rad = (d) => (d * Math.PI) / 180;

// The point `along` metres in direction az and `across` metres to its
// right, from origin (frame coordinates in and out).
function offset(origin, az, along, across, geo) {
  if (geo) {
    let ll = geo.toLL(origin);
    if (across) ll = direct(ll[0], ll[1], az + (across > 0 ? 90 : -90), Math.abs(across));
    if (along) ll = direct(ll[0], ll[1], az, along);
    return geo.fromLL(ll);
  }
  const t = rad(90 - az), r = rad(90 - az - 90);
  return [origin[0] + along * Math.cos(t) + across * Math.cos(r), origin[1] + along * Math.sin(t) + across * Math.sin(r)];
}

// Where p sits from origin: metres along az and across to its right.
export function local(origin, az, p, geo) {
  let d, b;
  if (geo) {
    const a = geo.toLL(origin), q = geo.toLL(p), g = inverse(a[0], a[1], q[0], q[1]);
    if (!g) return [NaN, NaN];
    d = g.s; b = g.az1;
  } else {
    d = Math.hypot(p[0] - origin[0], p[1] - origin[1]);
    b = 90 - (Math.atan2(p[1] - origin[1], p[0] - origin[0]) * 180) / Math.PI;
  }
  return [d * Math.cos(rad(b - az)), d * Math.sin(rad(b - az))];
}

// Parallel lines: count of them, spacing apart, each `length` long on
// azimuth az, starting `start` metres along; line k is k spacings to the
// right (centred: the set straddles the origin). Each line keeps the
// azimuth at its own start, so on the ellipsoid long lines are geodesics
// with a common initial azimuth.
export function transects(origin, { az, spacing, length, count, start = 0, first = 0, centred = false }, geo = null) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const k = first + (centred ? i - (count - 1) / 2 : i);
    const a = offset(origin, az, start, k * spacing, geo);
    out.push([a, offset(a, az, length, 0, geo)]);
  }
  return out;
}

// Transects at the given spacing that cover a polygon (rings in frame
// coordinates), phased so one line passes through the origin.
export function cover(origin, rings, { az, spacing, margin = 0 }, geo = null) {
  let a0 = Infinity, a1 = -Infinity, c0 = Infinity, c1 = -Infinity;
  for (const r of rings) for (const p of r) {
    const [al, ac] = local(origin, az, p, geo);
    a0 = Math.min(a0, al); a1 = Math.max(a1, al); c0 = Math.min(c0, ac); c1 = Math.max(c1, ac);
  }
  const first = Math.ceil(c0 / spacing), last = Math.floor(c1 / spacing);
  if (!(last >= first)) return [];
  return transects(origin, { az, spacing, length: a1 - a0 + 2 * margin, count: last - first + 1,
    start: a0 - margin, first }, geo);
}

// The pieces of a path (a polyline in frame coordinates) inside a
// polygon (rings, even-odd), each as its first and last point. On a
// geodesic the piece between two points is the geodesic between them,
// so the endpoints are all a piece needs.
export function clip(path, rings) {
  const inside = (p) => rings.reduce((v, r) => (pointInRing(p, r) ? !v : v), false);
  const pieces = [];
  let cur = null;
  for (let m = 0; m + 1 < path.length; m++) {
    const a = path[m], b = path[m + 1];
    const ts = [0, 1];
    for (const r of rings) {
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const t = segT(a, b, r[j], r[i]);
        if (t != null) ts.push(t);
      }
    }
    ts.sort((x, y) => x - y);
    for (let k = 0; k + 1 < ts.length; k++) {
      const t0 = ts[k], t1 = ts[k + 1];
      if (t1 - t0 < 1e-12) continue;
      const at = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (inside(at((t0 + t1) / 2))) {
        if (!cur) cur = [at(t0), at(t1)]; else cur[1] = at(t1);
      } else if (cur) { pieces.push(cur); cur = null; }
    }
  }
  if (cur) pieces.push(cur);
  return pieces;
}

// Parameter along ab where it crosses cd, or null.
function segT(a, b, c, d) {
  const rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (den === 0) return null;
  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// One track through the lines, alternating direction (boustrophedon).
export function lawnmower(lines) {
  const out = [];
  lines.forEach(([a, b], i) => { if (i % 2) out.push(b, a); else out.push(a, b); });
  return out;
}

// n copies of rings (arrays of frame points), copy j moved j * step
// metres along az: each vertex moved on the ellipsoid with a geo, so
// copies keep their ground shape; a plain translation without.
export function repeat(rings, { az, step, count }, geo = null) {
  const out = [];
  for (let j = 1; j <= count; j++) out.push(rings.map((r) => r.map((p) => offset(p, az, j * step, 0, geo))));
  return out;
}
