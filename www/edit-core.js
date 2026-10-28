// The editing engine behind edit.html: geometry, snapping, constraints
// and an operation log. No DOM here, so it runs under node for tests
// (scripts/edit-core-test.mjs) and maps one to one onto a Rust crate if
// the operation set settles.
//
// Coordinates are in the edit frame: a plane in which distances and
// angles mean what they say. Features keep their source coordinates
// beside the frame ones; a vertex no operation has touched is written
// back exactly as it was read.

import { direct } from "./edit-geo.js";

// ---- the edit frame -------------------------------------------------------

const R = 6371008.8; // mean Earth radius, metres

// A frame is the plane edits happen in. "native": the data's own
// projected coordinates. "local": longitude and latitude unrolled about a
// centre (equirectangular, scaled to metres at that latitude), good to a
// few parts per thousand across a city and a slot for a real CRS later.
export function makeFrame(kind, lon0 = 0, lat0 = 0) {
  if (kind === "native") {
    return { kind, label: "data coordinates", fwd: (p) => [p[0], p[1]], inv: (p) => [p[0], p[1]] };
  }
  const k = Math.cos((lat0 * Math.PI) / 180);
  const d = (Math.PI / 180) * R;
  const local = {
    kind, lon0, lat0,
    label: `local plane at ${lon0.toFixed(4)}, ${lat0.toFixed(4)} (metres, approximate)`,
    fwd: (p) => [(p[0] - lon0) * d * k, (p[1] - lat0) * d],
    inv: (p) => [lon0 + p[0] / (d * k), lat0 + p[1] / d],
  };
  local.toLL = local.inv; local.fromLL = local.fwd; // the source is longitude and latitude
  return local;
}

// ---- the document -----------------------------------------------------------

// A feature is { id, type, props, rings }, where type is the GeoJSON
// geometry type and each ring is { part, closed, xy: [[x, y]], src }.
// Polygon rings are stored without the repeated closing vertex. src[i]
// is the vertex as read (any length, z kept) or null once edited.

export function fromGeoJSON(gj) {
  const feats = gj.type === "FeatureCollection" ? gj.features
    : gj.type === "Feature" ? [gj] : [{ type: "Feature", properties: {}, geometry: gj }];
  const all = [];
  for (const f of feats) if (f && f.geometry) all.push(...flatCoords(f.geometry));
  let lonlat = all.length > 0;
  for (const c of all) if (Math.abs(c[0]) > 180 || Math.abs(c[1]) > 90) { lonlat = false; break; }
  let frame = makeFrame("native");
  if (lonlat) {
    const [x0, y0, x1, y1] = bboxOf(all);
    frame = makeFrame("local", (x0 + x1) / 2, (y0 + y1) / 2);
  }
  const doc = { frame, features: [], next: 1 };
  for (const f of feats) {
    if (!f || !f.geometry) continue;
    const feat = featureFrom(f.geometry, frame);
    if (!feat) continue;
    feat.props = f.properties || {};
    feat.id = f.id != null ? String(f.id) : "f" + doc.next;
    doc.next++;
    doc.features.push(feat);
  }
  return doc;
}

function flatCoords(g) {
  switch (g.type) {
    case "Point": return [g.coordinates];
    case "MultiPoint": case "LineString": return g.coordinates;
    case "MultiLineString": case "Polygon": return g.coordinates.flat();
    case "MultiPolygon": return g.coordinates.flat(2);
    case "GeometryCollection": return g.geometries.flatMap(flatCoords);
  }
  return [];
}

function ringFrom(coords, part, closed, frame) {
  let c = coords;
  if (closed && c.length > 1) {
    const a = c[0], b = c[c.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) c = c.slice(0, -1);
  }
  return { part, closed, xy: c.map((p) => frame.fwd(p)), src: c.map((p) => p.slice()) };
}

function featureFrom(g, frame) {
  const t = g.type, c = g.coordinates;
  let rings;
  if (t === "Point") rings = [ringFrom([c], 0, false, frame)];
  else if (t === "MultiPoint") rings = c.map((p, i) => ringFrom([p], i, false, frame));
  else if (t === "LineString") rings = [ringFrom(c, 0, false, frame)];
  else if (t === "MultiLineString") rings = c.map((l, i) => ringFrom(l, i, false, frame));
  else if (t === "Polygon") rings = c.map((r) => ringFrom(r, 0, true, frame));
  else if (t === "MultiPolygon") rings = c.flatMap((poly, i) => poly.map((r) => ringFrom(r, i, true, frame)));
  else return null; // GeometryCollection: not editable here
  return { id: "", type: t, props: {}, rings };
}

// Back to GeoJSON in the source coordinates: untouched vertices as read,
// edited ones through the frame's inverse.
export function toGeoJSON(doc) {
  const out = [];
  for (const f of doc.features) {
    const rc = f.rings.map((r) => {
      const c = r.xy.map((p, i) => (r.src[i] ? r.src[i].slice() : doc.frame.inv(p)));
      if (r.closed && c.length) c.push(c[0].slice());
      return { part: r.part, c };
    });
    let coords;
    switch (f.type) {
      case "Point": coords = rc[0].c[0]; break;
      case "MultiPoint": coords = rc.map((r) => r.c[0]); break;
      case "LineString": coords = rc[0].c; break;
      case "MultiLineString": coords = rc.map((r) => r.c); break;
      case "Polygon": coords = rc.map((r) => r.c); break;
      case "MultiPolygon": {
        coords = [];
        for (const r of rc) (coords[r.part] ||= []).push(r.c);
        coords = coords.filter(Boolean);
        break;
      }
    }
    out.push({ type: "Feature", id: f.id, properties: f.props, geometry: { type: f.type, coordinates: coords } });
  }
  return { type: "FeatureCollection", features: out };
}

export function featureById(doc, id) {
  return doc.features.find((f) => f.id === id);
}

export function bboxOf(pts) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0];
    if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1];
  }
  return [x0, y0, x1, y1];
}

// Move a document into another frame. Untouched vertices are recomputed
// from their source coordinates; edited ones go back through the old
// frame and forward through the new one.
export function reframe(doc, frame) {
  const old = doc.frame;
  for (const f of doc.features) {
    for (const r of f.rings) {
      r.xy = r.xy.map((p, i) => frame.fwd(r.src[i] || old.inv(p)));
      r._bb = null; r._curves = null; r._x = null;
    }
  }
  doc.frame = frame;
}

export function docBbox(doc) {
  return bboxOf(doc.features.flatMap((f) => f.rings.flatMap((r) => r.xy)));
}

// ---- geometry ---------------------------------------------------------------

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, k) => [a[0] * k, a[1] * k];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
export const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

export function closestOnSegment(p, a, b) {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  const q = add(a, mul(ab, t));
  return { pt: q, t, d: dist(p, q) };
}

// Intersection of segments ab and cd, endpoints included; null if none
// or parallel.
export function segmentIntersection(a, b, c, d) {
  const r = sub(b, a), s = sub(d, c);
  const den = cross(r, s);
  if (Math.abs(den) < 1e-15 * (len(r) * len(s) || 1)) return null;
  const t = cross(sub(c, a), s) / den;
  const u = cross(sub(c, a), r) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return add(a, mul(r, t));
}

// Intersection of the infinite lines through (o, dir) and (c, d).
export function lineLine(o, dir, c, d) {
  const s = sub(d, c);
  const den = cross(dir, s);
  if (Math.abs(den) < 1e-15 * (len(s) || 1)) return null;
  return add(o, mul(dir, cross(sub(c, o), s) / den));
}

// Points where the line through (o, dir) meets the circle (c, r).
export function lineCircle(o, dir, c, r) {
  const f = sub(o, c);
  const b = dot(f, dir), cc = dot(f, f) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return [];
  const sq = Math.sqrt(disc);
  return [add(o, mul(dir, -b - sq)), add(o, mul(dir, -b + sq))];
}

export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

// Each segment of a ring as [i, j] vertex indices.
export function segments(ring) {
  const n = ring.xy.length, out = [];
  for (let i = 0; i + 1 < n; i++) out.push([i, i + 1]);
  if (ring.closed && n > 2) out.push([n - 1, 0]);
  return out;
}

// Area (shoelace, frame units squared) and length of a ring.
export function ringArea(xy) {
  let s = 0;
  for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) s += cross(xy[j], xy[i]);
  return s / 2;
}

export function ringLength(ring) {
  return segments(ring).reduce((s, [i, j]) => s + dist(ring.xy[i], ring.xy[j]), 0);
}

// ---- angles -------------------------------------------------------------------

// Angles the user types and reads are degrees, either counter-clockwise
// from east ("math") or clockwise from north ("bearing"). Inside, all
// directions are math radians.
export function toTheta(deg, conv) {
  return ((conv === "bearing" ? 90 - deg : deg) * Math.PI) / 180;
}

export function fromTheta(theta, conv) {
  let deg = (theta * 180) / Math.PI;
  if (conv === "bearing") deg = 90 - deg;
  return ((deg % 360) + 360) % 360;
}

// A relative angle is a turn from the previous segment's direction, in
// the same sense as the absolute convention.
export function relTheta(deg, prevTheta, conv) {
  const t = (deg * Math.PI) / 180;
  return conv === "bearing" ? prevTheta - t : prevTheta + t;
}

// ---- snapping -------------------------------------------------------------------

// Candidates near p within tol (frame units), best first by kind and
// then distance. opts: { vertex, segment, middle, intersection, grid,
// gridStep }. skip(f, r, i) hides a vertex; skipSeg(f, r, i, j) hides a
// segment (the ones being dragged). extra: draft paths to self-snap to.
const RANK = { vertex: 0, intersection: 1, middle: 2, segment: 3, grid: 4 };

export function snap(doc, p, tol, opts, skip = () => false, skipSeg = () => false, extra = []) {
  const best = [];
  const near = []; // segments within tol, for intersections
  const consider = (pt, kind, info) => {
    const d = dist(p, pt);
    if (d <= tol) best.push({ pt, kind, d, ...info });
  };
  const visit = (fid, ri, ring) => {
    const xy = ring.xy;
    if (!xy.length) return;
    // cheap reject on the ring's bbox
    const bb = ring._bb || (ring._bb = bboxOf(xy));
    if (p[0] < bb[0] - tol || p[0] > bb[2] + tol || p[1] < bb[1] - tol || p[1] > bb[3] + tol) return;
    if (opts.vertex) xy.forEach((v, i) => { if (!skip(fid, ri, i)) consider(v, "vertex", { fid, ri, vi: i }); });
    const segs = segments(ring);
    const paths = segmentPaths(ring, opts);
    segs.forEach(([i, j], k) => {
      if (skipSeg(fid, ri, i, j)) return;
      const path = paths[k];
      let best = null;
      for (let m = 0; m + 1 < path.length; m++) {
        const c = closestOnSegment(p, path[m], path[m + 1]);
        if (c.d <= tol) near.push([path[m], path[m + 1]]);
        if (!best || c.d < best.d) best = { ...c, seg: [path[m], path[m + 1]] };
      }
      if (!best || best.d > tol) return;
      if (opts.segment) consider(best.pt, "segment", { fid, ri, seg: best.seg });
      if (opts.middle) consider(opts.mid ? opts.mid(xy[i], xy[j]) : mul(add(xy[i], xy[j]), 0.5), "middle", { fid, ri, seg: best.seg });
    });
  };
  for (const f of doc.features) f.rings.forEach((r, ri) => visit(f.id, ri, r));
  extra.forEach((r, ri) => { r._bb = null; r._curves = null; visit("draft", ri, r); });
  if (opts.intersection) {
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        const [a, b] = near[i], [c, d] = near[j];
        // shared endpoints are vertices, not intersections
        if (a === c || a === d || b === c || b === d) continue;
        const x = segmentIntersection(a, b, c, d);
        if (x) consider(x, "intersection", {});
      }
    }
  }
  best.sort((u, v) => RANK[u.kind] - RANK[v.kind] || u.d - v.d);
  if (best.length) return best[0];
  if (opts.grid && opts.gridStep > 0) {
    const g = opts.gridStep;
    return { pt: [Math.round(p[0] / g) * g, Math.round(p[1] / g) * g], kind: "grid", d: 0 };
  }
  return null;
}

// Drop the cached bboxes of a feature's rings after an edit.
export function touch(f) {
  for (const r of f.rings) { r._bb = null; r._curves = null; r._x = null; }
}

// ---- simple rings ---------------------------------------------------------------------

// True when segments ab and cd cross at a point interior to both: a
// shared endpoint or a collinear touch is not a crossing.
export function crosses(a, b, c, d) {
  const o1 = cross(sub(b, a), sub(c, a)), o2 = cross(sub(b, a), sub(d, a));
  const o3 = cross(sub(d, c), sub(a, c)), o4 = cross(sub(d, c), sub(b, c));
  return o1 * o2 < 0 && o3 * o4 < 0;
}

// Where the rings cross themselves or each other: [{ ri, i, rj, j, at }]
// for segment i of ring ri crossing segment j of ring rj. A polygon
// with any is invalid; a line with any is valid but not simple. Pairs
// are pruned by bounding box; brute force within that.
export function crossings(rings) {
  const segs = [];
  rings.forEach((r, ri) => {
    const xy = r.xy, n = xy.length, m = r.closed && n > 2 ? n : n - 1;
    for (let i = 0; i < m; i++) {
      const a = xy[i], b = xy[(i + 1) % n];
      segs.push({ ri, i, a, b, x0: Math.min(a[0], b[0]), x1: Math.max(a[0], b[0]),
        y0: Math.min(a[1], b[1]), y1: Math.max(a[1], b[1]) });
    }
  });
  segs.sort((p, q) => p.x0 - q.x0);
  const out = [];
  for (let k = 0; k < segs.length; k++) {
    const p = segs[k];
    for (let l = k + 1; l < segs.length && segs[l].x0 <= p.x1; l++) {
      const q = segs[l];
      if (q.y0 > p.y1 || q.y1 < p.y0 || !crosses(p.a, p.b, q.a, q.b)) continue;
      out.push({ ri: p.ri, i: p.i, rj: q.ri, j: q.i, at: segmentIntersection(p.a, p.b, q.a, q.b) });
    }
  }
  return out;
}

// crossings() of a feature, cached until the feature is touched.
export function featureCrossings(f) {
  const r0 = f.rings[0];
  if (!r0) return [];
  return r0._x || (r0._x = crossings(f.rings));
}

// Would vertex i of ring w, moved to p, make one of its two segments
// cross a segment of any ring in rings (w among them)?
function movesCross(rings, w, i, p) {
  const n = w.xy.length;
  const nb = [];
  if (i > 0 || (w.closed && n > 2)) nb.push(w.xy[(i - 1 + n) % n]);
  if (i < n - 1 || (w.closed && n > 2)) nb.push(w.xy[(i + 1) % n]);
  for (const q of nb) {
    for (const r of rings) {
      const xy = r.xy, m = xy.length, segs = r.closed && m > 2 ? m : m - 1;
      for (let j = 0; j < segs; j++) {
        if (r === w && (j === i || (j + 1) % m === i)) continue;
        if (crosses(p, q, xy[j], xy[(j + 1) % m])) return true;
      }
    }
  }
  return false;
}

// The drawn path of each segment of a ring: [a, b] for straight grid
// edges, or opts.curve(a, b) (a geodesic, say) cached on the ring under
// opts.curveKey.
export function segmentPaths(ring, opts = {}) {
  const segs = segments(ring);
  if (!opts.curve) return segs.map(([i, j]) => [ring.xy[i], ring.xy[j]]);
  if (!ring._curves || ring._curvesKey !== opts.curveKey) {
    ring._curves = segs.map(([i, j]) => opts.curve(ring.xy[i], ring.xy[j]));
    ring._curvesKey = opts.curveKey;
  }
  return ring._curves;
}

// ---- constraints ---------------------------------------------------------------

// cs: { x, y, d, a } each { on, val, rel } (rel for x, y, a), the angle
// convention conv, and bearingStep (degrees, 0 = off) with bearingRel.
// ref is the reference point (the previous vertex); prevTheta the
// direction of the segment before it, or null. cursor is the (possibly
// snapped) pointer; snapSeg the segment it snapped to, if any. Returns
// the constrained point and the guides to draw.
//
// With geo (edit-geo.js makeGeo) the grid meets the ground: cs.north
// "true" reads absolute angles and bearing steps as true azimuths (grid
// convergence applied at ref), and cs.measure "ground" reads distances
// on the ellipsoid (the point scale factor at ref; exact geodesic when
// both angle and distance are locked).
export function constrain(cursor, ref, prevTheta, cs, snapSeg = null, geo = null) {
  const conv = cs.conv || "math";
  const trueN = !!(geo && cs.north === "true" && ref);
  const ground = !!(geo && cs.measure === "ground" && ref);
  const guides = [];
  const X = cs.x.on ? (cs.x.rel && ref ? ref[0] + cs.x.val : cs.x.val) : null;
  const Y = cs.y.on ? (cs.y.rel && ref ? ref[1] + cs.y.val : cs.y.val) : null;
  if (X != null) guides.push({ kind: "xline", x: X });
  if (Y != null) guides.push({ kind: "yline", y: Y });
  if (X != null && Y != null) return { pt: [X, Y], guides };
  if (!ref) {
    const pt = [X ?? cursor[0], Y ?? cursor[1]];
    return { pt, guides };
  }

  // a direction from the angle lock, or from bearing snapping
  let theta = null, az = null;
  if (cs.a.on) {
    if (cs.a.rel && prevTheta != null) theta = relTheta(cs.a.val, prevTheta, conv);
    else if (trueN) { az = conv === "bearing" ? cs.a.val : 90 - cs.a.val; theta = geo.gridTheta(ref, az); }
    else theta = toTheta(cs.a.val, conv);
  } else if (cs.bearingStep > 0 && dist(cursor, ref) > 0 && trueN && !(cs.bearingRel && prevTheta != null)) {
    const raw = geo.trueAz(ref, Math.atan2(cursor[1] - ref[1], cursor[0] - ref[0]));
    const base = conv === "bearing" ? 0 : 90; // north, or east, true
    az = base + Math.round((raw - base) / cs.bearingStep) * cs.bearingStep;
    theta = geo.gridTheta(ref, az);
  } else if (cs.bearingStep > 0 && dist(cursor, ref) > 0) {
    const raw = Math.atan2(cursor[1] - ref[1], cursor[0] - ref[0]);
    const base = cs.bearingRel && prevTheta != null ? prevTheta : (conv === "bearing" ? Math.PI / 2 : 0);
    const step = (cs.bearingStep * Math.PI) / 180;
    theta = base + Math.round((raw - base) / step) * step;
  }

  if (theta != null) {
    const dir = [Math.cos(theta), Math.sin(theta)];
    guides.push({ kind: "ray", o: ref, dir });
    let pt;
    if (cs.d.on && ground) {
      const ll = geo.toLL(ref);
      pt = geo.fromLL(direct(ll[0], ll[1], az ?? geo.trueAz(ref, theta), cs.d.val));
    } else if (cs.d.on) pt = add(ref, mul(dir, cs.d.val));
    else if (X != null && Math.abs(dir[0]) > 1e-12) pt = add(ref, mul(dir, (X - ref[0]) / dir[0]));
    else if (Y != null && Math.abs(dir[1]) > 1e-12) pt = add(ref, mul(dir, (Y - ref[1]) / dir[1]));
    else if (snapSeg) pt = lineLine(ref, dir, snapSeg[0], snapSeg[1]);
    if (!pt) pt = add(ref, mul(dir, dot(sub(cursor, ref), dir)));
    return { pt, guides };
  }

  if (cs.d.on) {
    const r = ground ? cs.d.val * geo.scale(ref, Math.atan2(cursor[1] - ref[1], cursor[0] - ref[0]) || 0) : cs.d.val;
    guides.push({ kind: "circle", c: ref, r });
    let cands = [];
    if (X != null) cands = lineCircle([X, 0], [0, 1], ref, r);
    else if (Y != null) cands = lineCircle([0, Y], [1, 0], ref, r);
    else if (snapSeg) {
      const s = sub(snapSeg[1], snapSeg[0]);
      const l = len(s);
      if (l > 0) cands = lineCircle(snapSeg[0], mul(s, 1 / l), ref, r);
    }
    if (cands.length) {
      cands.sort((u, v) => dist(u, cursor) - dist(v, cursor));
      return { pt: cands[0], guides };
    }
    const v = sub(cursor, ref);
    const l = len(v) || 1;
    return { pt: add(ref, mul(v, r / l)), guides };
  }

  return { pt: [X ?? cursor[0], Y ?? cursor[1]], guides };
}

// Direction of the segment that ends at xy[i] (from xy[i-1]), or null.
export function prevDirection(xy, i, closed) {
  const n = xy.length;
  let j = i - 1;
  if (j < 0) { if (!closed || n < 3) return null; j = n - 1; }
  const a = xy[j], b = xy[i];
  if (!a || !b || dist(a, b) === 0) return null;
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

// ---- operations ------------------------------------------------------------------

// Each operation is a plain object, applied by apply() and undone by
// apply(invert(op)). The log of applied operations is the edit's
// record: replayed over the source it gives the edited features.
//
//   { op: "move",   fid, ri, vi, to, from, src }
//   { op: "insert", fid, ri, vi, xy }
//   { op: "delete", fid, ri, vi, xy, src }
//   { op: "add",    feature }            (feature as stored, deep copy)
//   { op: "remove", feature, index }
//   { op: "batch",  ops }
//   { op: "reshape", fid, ri, before: { xy, src }, after: { xy, src } }

export function apply(doc, op) {
  switch (op.op) {
    case "move": {
      const r = featureById(doc, op.fid).rings[op.ri];
      if (op.from === undefined) op.from = r.xy[op.vi].slice();
      if (op.src === undefined) op.src = r.src[op.vi];
      r.xy[op.vi] = op.to.slice();
      r.src[op.vi] = op.restore ? op.restore : null;
      touch(featureById(doc, op.fid));
      break;
    }
    case "insert": {
      const r = featureById(doc, op.fid).rings[op.ri];
      r.xy.splice(op.vi, 0, op.xy.slice());
      r.src.splice(op.vi, 0, op.restore || null);
      touch(featureById(doc, op.fid));
      break;
    }
    case "delete": {
      const r = featureById(doc, op.fid).rings[op.ri];
      if (op.xy === undefined) op.xy = r.xy[op.vi].slice();
      if (op.src === undefined) op.src = r.src[op.vi];
      r.xy.splice(op.vi, 1);
      r.src.splice(op.vi, 1);
      touch(featureById(doc, op.fid));
      break;
    }
    case "add": {
      const f = clone(op.feature);
      if (op.index != null) doc.features.splice(op.index, 0, f); else doc.features.push(f);
      break;
    }
    case "remove": {
      const i = doc.features.findIndex((f) => f.id === op.feature.id);
      if (op.index === undefined) op.index = i;
      doc.features.splice(i, 1);
      break;
    }
    case "batch":
      for (const o of op.ops) apply(doc, o);
      break;
    case "reshape": {
      const r = featureById(doc, op.fid).rings[op.ri];
      r.xy = op.after.xy.map((p) => p.slice());
      r.src = op.after.src.map((p) => (p ? p.slice() : null));
      touch(featureById(doc, op.fid));
      break;
    }
  }
  return op;
}

export function invert(op) {
  switch (op.op) {
    case "move": return { op: "move", fid: op.fid, ri: op.ri, vi: op.vi, to: op.from, from: op.to, restore: op.src };
    case "insert": return { op: "delete", fid: op.fid, ri: op.ri, vi: op.vi, xy: op.xy };
    case "delete": return { op: "insert", fid: op.fid, ri: op.ri, vi: op.vi, xy: op.xy, restore: op.src };
    case "add": return { op: "remove", feature: op.feature };
    case "remove": return { op: "add", feature: op.feature, index: op.index };
    case "batch": return { op: "batch", ops: op.ops.map(invert).reverse() };
    case "reshape": return { op: "reshape", fid: op.fid, ri: op.ri, before: op.after, after: op.before };
  }
}

export function clone(f) {
  return {
    id: f.id, type: f.type, props: JSON.parse(JSON.stringify(f.props || {})),
    rings: f.rings.map((r) => ({ part: r.part, closed: r.closed, xy: r.xy.map((p) => p.slice()),
      src: r.src.map((p) => (p ? p.slice() : null)) })),
  };
}

// A history: the applied operations and the ones undone, for redo.
export class History {
  constructor(doc) { this.doc = doc; this.done = []; this.undone = []; }
  run(op) { apply(this.doc, op); this.done.push(op); this.undone = []; return op; }
  // An operation already applied to the document (a nudge stroke).
  record(op) { this.done.push(op); this.undone = []; return op; }
  undo() {
    const op = this.done.pop();
    if (!op) return null;
    apply(this.doc, invert(op));
    this.undone.push(op);
    return op;
  }
  redo() {
    const op = this.undone.pop();
    if (!op) return null;
    // replay the original operation, carrying the source it recorded
    const again = { ...op };
    if (op.op === "move" || op.op === "delete") { delete again.from; delete again.src; }
    apply(this.doc, again);
    this.done.push(again);
    return again;
  }
  // The log as JSON lines, frame coordinates, without cached fields.
  log() {
    return this.done.map((o) => JSON.stringify(o, (k, v) => (k[0] === "_" ? undefined : v))).join("\n");
  }
}

// Minimum vertex counts, so a delete cannot leave a broken ring.
export function canDelete(ring) {
  return ring.xy.length > (ring.closed ? 3 : ring.xy.length === 1 ? 1 : 2);
}

// A new feature from a drawn path.
export function newFeature(doc, type, xy) {
  const id = "new" + doc.next++;
  const closed = type === "Polygon";
  const rings = type === "Point"
    ? [{ part: 0, closed: false, xy: [xy[0].slice()], src: [null] }]
    : [{ part: 0, closed, xy: xy.map((p) => p.slice()), src: xy.map(() => null) }];
  return { id, type, props: {}, rings };
}

// ---- the nudge brush ----------------------------------------------------------------

// A soft ball dragged against a ring. Each step first densifies the
// segments the ball touches (no gap longer than step, so detail follows
// the zoom), then moves the vertices inside the ball: "push" moves them
// toward the rim (power 1 is a hard ball, less is softer); "smudge"
// carries them along with the pointer's motion delta, weighted by a
// smooth falloff from the centre. w is a working ring { xy, src, ins,
// moved } that finishNudge() turns back into a plain one. keep, when
// given, is the feature's working rings (w among them): no vertex is
// moved so that its segments cross another, so the stroke cannot make
// a simple ring self-intersecting.
export function nudgeStart(ring) {
  return { closed: ring.closed, xy: ring.xy.map((p) => p.slice()), src: ring.src.slice(),
    ins: ring.xy.map(() => false), moved: ring.xy.map(() => false) };
}

export function nudgeStep(w, c, r, step, power, mode = "push", delta = [0, 0], keep = null) {
  if (w.xy.length > 1 && step > 0) {
    const n = w.xy.length;
    const segs = w.closed && n > 2 ? n : n - 1;
    const out = { xy: [], src: [], ins: [], moved: [] };
    for (let i = 0; i < n; i++) {
      out.xy.push(w.xy[i]); out.src.push(w.src[i]); out.ins.push(w.ins[i]); out.moved.push(w.moved[i]);
      if (i >= segs) continue;
      const a = w.xy[i], b = w.xy[(i + 1) % n];
      const l = dist(a, b);
      if (l <= step || closestOnSegment(c, a, b).d >= r) continue;
      const k = Math.ceil(l / step);
      for (let j = 1; j < k; j++) {
        out.xy.push(add(a, mul(sub(b, a), j / k))); out.src.push(null); out.ins.push(true); out.moved.push(false);
      }
    }
    Object.assign(w, out);
  }
  let count = 0;
  for (let i = 0; i < w.xy.length; i++) {
    const v = w.xy[i];
    const d = dist(v, c);
    if (d >= r) continue;
    let to;
    if (mode === "smudge") {
      const f = (1 - (d / r) ** 2) ** 2;
      to = add(v, mul(delta, power * f));
    } else {
      if (d === 0) continue;
      const rim = add(c, mul(sub(v, c), r / d));
      to = add(v, mul(sub(rim, v), power));
    }
    if (keep && movesCross(keep, w, i, to) && !movesCross(keep, w, i, v)) {
      // keep the rings simple: go as far as the move stays clear of
      // every other segment, which stops the vertex at the obstacle
      let lo = 0, hi = 1;
      for (let it = 0; it < 12; it++) {
        const t = (lo + hi) / 2;
        if (movesCross(keep, w, i, add(v, mul(sub(to, v), t)))) hi = t; else lo = t;
      }
      if (lo === 0) continue;
      to = add(v, mul(sub(to, v), lo));
    }
    w.xy[i] = to; w.src[i] = null; w.moved[i] = true; count++;
  }
  return count;
}

// Drop the vertices densification added but the stroke never moved.
export function finishNudge(w) {
  const keep = w.xy.map((_, i) => !(w.ins[i] && !w.moved[i]));
  return { xy: w.xy.filter((_, i) => keep[i]), src: w.src.filter((_, i) => keep[i]) };
}
