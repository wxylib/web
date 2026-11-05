// Parametric shapes for the editing canvas: a circle, a regular polygon,
// a rectangle and an arc through three points. A shape is a small object
// of parameters kept in the feature's properties (under "wxy:shape")
// beside the vertices it produces, so either can be edited: change a
// parameter and the vertices follow; move a vertex and the feature
// becomes plain geometry (undo brings the shape back). Points are stored
// in the data's own coordinates, so a shape survives a change of frame.
// No DOM; tested under node.
//
//   { kind: "circle", c, r, n, ground }        Polygon, n vertices
//   { kind: "ngon",   c, r, n, rot, ground }   Polygon, first vertex at azimuth rot
//   { kind: "rect",   o, w, h, az, ground }    Polygon, w along az from corner o, h to its right
//   { kind: "arc",    a, b, c, n }             LineString from a through b to c
//
// ground: r, w and h are metres on the ellipsoid and azimuths are true
// (each vertex placed by the geo's direct solution); otherwise frame
// units and grid bearings. Arcs are circles in the frame.

import { direct } from "./edit-geo.js";

export const SHAPE_KEY = "wxy:shape";

const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
const norm360 = (d) => ((d % 360) + 360) % 360;

// The point s along azimuth az from frame point p: on the ellipsoid
// with a geo and ground set, in the frame otherwise.
function step(p, az, s, geo, ground) {
  if (ground && geo) {
    const ll = geo.toLL(p);
    return geo.fromLL(geo.lineDirect ? geo.lineDirect(ll, az, s) : direct(ll[0], ll[1], az, s));
  }
  return [p[0] + s * Math.sin(rad(az)), p[1] + s * Math.cos(rad(az))];
}

// The circle through three frame points, or null when they are in line.
export function circle3(a, b, c) {
  const bx = b[0] - a[0], by = b[1] - a[1], cx = c[0] - a[0], cy = c[1] - a[1];
  const d = 2 * (bx * cy - by * cx);
  if (Math.abs(d) < 1e-12 * (bx * bx + by * by + cx * cx + cy * cy)) return null;
  const b2 = bx * bx + by * by, c2 = cx * cx + cy * cy;
  const ux = (cy * b2 - by * c2) / d, uy = (bx * c2 - cx * b2) / d;
  return { c: [a[0] + ux, a[1] + uy], r: Math.hypot(ux, uy) };
}

// The arc from a through b to c: its circle, start angle and signed sweep
// (radians, counter-clockwise positive), or null when the points are in line.
export function arc3(a, b, c) {
  const k = circle3(a, b, c);
  if (!k) return null;
  const ang = (p) => Math.atan2(p[1] - k.c[1], p[0] - k.c[0]);
  const t0 = ang(a), tb = ang(b), t1 = ang(c);
  const ccw = (t) => ((t - t0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
  // counter-clockwise from a, b comes before c, or the arc runs clockwise
  const sweep = ccw(tb) <= ccw(t1) ? ccw(t1) : ccw(t1) - 2 * Math.PI;
  return { ...k, t0, sweep };
}

// The shape's ring in frame coordinates: { type, closed, xy }. frame
// maps the stored points (data coordinates) into the frame.
export function shapeRing(shape, frame, geo = null) {
  const fwd = (p) => frame.fwd(p);
  const g = !!shape.ground && !!geo;
  switch (shape.kind) {
    case "circle":
    case "ngon": {
      const c = fwd(shape.c), n = Math.max(3, Math.round(shape.n));
      const rot = shape.kind === "ngon" ? shape.rot || 0 : 0;
      const xy = [];
      for (let i = 0; i < n; i++) xy.push(step(c, norm360(rot + (360 * i) / n), shape.r, geo, g));
      return { type: "Polygon", closed: true, xy };
    }
    case "rect": {
      const o = fwd(shape.o);
      const p1 = step(o, shape.az, shape.w, geo, g);
      const p3 = step(o, shape.az + 90, shape.h, geo, g);
      // the far corner from the near ones, each side its own direct step
      const p2 = step(p1, shape.az + 90, shape.h, geo, g);
      return { type: "Polygon", closed: true, xy: [o, p1, p2, p3] };
    }
    case "arc": {
      const a = fwd(shape.a), b = fwd(shape.b), c = fwd(shape.c);
      const k = arc3(a, b, c);
      if (!k) return { type: "LineString", closed: false, xy: [a, c] };
      const n = Math.max(2, Math.round(shape.n));
      const xy = [a];
      for (let i = 1; i < n; i++) {
        const t = k.t0 + (k.sweep * i) / n;
        xy.push([k.c[0] + k.r * Math.cos(t), k.c[1] + k.r * Math.sin(t)]);
      }
      xy.push(c);
      return { type: "LineString", closed: false, xy };
    }
  }
  return null;
}

// What the panel shows as the arc's derived measures (frame units).
export function arcInfo(shape, frame) {
  const k = arc3(frame.fwd(shape.a), frame.fwd(shape.b), frame.fwd(shape.c));
  return k && { r: k.r, sweep: deg(k.sweep), length: Math.abs(k.sweep) * k.r };
}

// The shape a drag makes, from press point p to current point q (frame
// coordinates), given the kind and its options; inv maps frame points
// to data coordinates for storage. Ground distances and azimuths come
// from the geo's edge model when ground is set.
export function shapeFromDrag(kind, p, q, { n = 72, az = 0, ground = false } = {}, geo = null, inv = (x) => x) {
  let s, b;
  if (ground && geo) {
    const g = geo.lineInverse(geo.toLL(p), geo.toLL(q));
    s = g ? g.s : 0; b = g ? g.az : 0;
  } else {
    s = Math.hypot(q[0] - p[0], q[1] - p[1]);
    b = norm360(90 - deg(Math.atan2(q[1] - p[1], q[0] - p[0])));
  }
  switch (kind) {
    case "circle": return { kind, c: inv(p), r: s, n, ground };
    case "ngon": return { kind, c: inv(p), r: s, n, rot: b, ground };
    case "rect": {
      // the drag is the diagonal: its components along az and to the right
      const t = rad(b - az);
      let w = s * Math.cos(t), h = s * Math.sin(t), a = az;
      // keep w and h positive by starting from another corner
      if (w < 0 && h < 0) { a = norm360(az + 180); w = -w; h = -h; }
      else if (w < 0) { a = norm360(az + 90); [w, h] = [h, -w]; }
      else if (h < 0) { a = norm360(az - 90); [w, h] = [-h, w]; }
      return { kind, o: inv(p), w, h, az: a, ground };
    }
  }
  return null;
}
