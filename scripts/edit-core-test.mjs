// Tests for www/edit-core.js: node scripts/edit-core-test.mjs
import assert from "node:assert/strict";
import {
  fromGeoJSON, toGeoJSON, snap, constrain, History, toTheta, fromTheta, featureById,
  nudgeStart, nudgeStep, finishNudge, apply, crossings, makeFrame,
} from "../www/edit-core.js";
import { inverse, direct, makeGeo, rhumbInverse, rhumbDirect } from "../www/edit-geo.js";
import { transects, cover, clip, lawnmower, repeat } from "../www/edit-pattern.js";
import { circle3, arc3, shapeRing, shapeFromDrag, SHAPE_KEY } from "../www/edit-shape.js";

const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const nearPt = (p, q, tol = 1e-9) => { near(p[0], q[0], tol); near(p[1], q[1], tol); };

let n = 0;
const test = (name, fn) => { fn(); n++; console.log("ok", name); };

const square = {
  type: "FeatureCollection",
  features: [
    { type: "Feature", id: "a", properties: {}, geometry: { type: "Polygon",
      coordinates: [[[1000, 1000], [1010, 1000], [1010, 1010], [1000, 1010], [1000, 1000]]] } },
    { type: "Feature", id: "l", properties: {}, geometry: { type: "LineString",
      coordinates: [[995, 1005, 7], [1015, 1005, 8]] } },
  ],
};

test("projected data edits in its own coordinates", () => {
  const doc = fromGeoJSON(square);
  assert.equal(doc.frame.kind, "native");
  assert.equal(featureById(doc, "a").rings[0].xy.length, 4); // closing vertex dropped
});

test("round trip without edits is exact, z kept", () => {
  const doc = fromGeoJSON(square);
  assert.deepEqual(toGeoJSON(doc).features.map((f) => f.geometry), square.features.map((f) => f.geometry));
});

test("lon/lat data gets a local metric frame; untouched vertices come back bit for bit", () => {
  const gj = { type: "Feature", properties: {}, geometry: { type: "LineString",
    coordinates: [[147.3257, -42.8826], [147.3301, -42.8811], [147.3349, -42.8790]] } };
  const doc = fromGeoJSON(gj);
  assert.equal(doc.frame.kind, "local");
  const h = new History(doc);
  const f = doc.features[0];
  const to = f.rings[0].xy[1].map((v) => v + 10);
  h.run({ op: "move", fid: f.id, ri: 0, vi: 1, to });
  const out = toGeoJSON(doc).features[0].geometry.coordinates;
  assert.deepEqual(out[0], gj.geometry.coordinates[0]);
  assert.deepEqual(out[2], gj.geometry.coordinates[2]);
  assert.notDeepEqual(out[1], gj.geometry.coordinates[1]);
  // 10 m east and north is about 0.000122 deg east, 0.0000899 deg north here
  near(out[1][0] - 147.3301, 10 / (6371008.8 * Math.PI / 180 * Math.cos(-42.8808 * Math.PI / 180)), 1e-6);
  near(out[1][1] + 42.8811, 10 / (6371008.8 * Math.PI / 180), 1e-9);
});

test("snap order: vertex beats intersection beats middle beats segment", () => {
  const doc = fromGeoJSON(square);
  const all = { vertex: true, segment: true, middle: true, intersection: true };
  assert.equal(snap(doc, [1000.3, 1000.2], 1, all).kind, "vertex");
  const x = snap(doc, [1000.2, 1005.3], 1, all);
  assert.equal(x.kind, "intersection");
  nearPt(x.pt, [1000, 1005]);
  assert.equal(snap(doc, [1005.2, 1000.1], 1, all).kind, "middle");
  const s = snap(doc, [1003, 1000.4], 1, all);
  assert.equal(s.kind, "segment");
  nearPt(s.pt, [1003, 1000]);
  assert.equal(snap(doc, [1003, 1003], 1, all), null);
  const g = snap(doc, [1003.4, 1003.6], 1, { grid: true, gridStep: 0.5 });
  nearPt(g.pt, [1003.5, 1003.5]);
});

const cs0 = () => ({ conv: "math", d: { on: false, val: 0 }, a: { on: false, val: 0, rel: false },
  x: { on: false, val: 0, rel: false }, y: { on: false, val: 0, rel: false }, bearingStep: 0 });

test("distance and angle locks fix the point", () => {
  const cs = cs0();
  cs.d = { on: true, val: 5 }; cs.a = { on: true, val: 30, rel: false };
  const { pt } = constrain([50, 50], [0, 0], null, cs);
  nearPt(pt, [5 * Math.cos(Math.PI / 6), 5 * Math.sin(Math.PI / 6)]);
});

test("bearing convention: 90 is east, 0 is north", () => {
  near(fromTheta(toTheta(90, "bearing"), "math"), 0);
  const cs = cs0();
  cs.conv = "bearing"; cs.d = { on: true, val: 2 }; cs.a = { on: true, val: 0, rel: false };
  nearPt(constrain([9, 9], [1, 1], null, cs).pt, [1, 3]);
});

test("relative angle turns from the previous segment", () => {
  const cs = cs0();
  cs.a = { on: true, val: 90, rel: true }; cs.d = { on: true, val: 1 };
  nearPt(constrain([0, 0], [10, 0], 0, cs).pt, [10, 1]);
  cs.conv = "bearing"; // clockwise turn
  nearPt(constrain([0, 0], [10, 0], 0, cs).pt, [10, -1]);
});

test("distance lock with an x lock picks the circle crossing nearest the cursor", () => {
  const cs = cs0();
  cs.d = { on: true, val: 5 }; cs.x = { on: true, val: 3, rel: true };
  nearPt(constrain([3, -9], [0, 0], null, cs).pt, [3, -4]);
});

test("angle lock plus a segment snap lands on their crossing", () => {
  const cs = cs0();
  cs.a = { on: true, val: 45, rel: false };
  nearPt(constrain([7, 7.2], [0, 0], null, cs, [[6, -10], [6, 10]]).pt, [6, 6]);
});

test("bearing steps quantise the direction", () => {
  const cs = cs0();
  cs.bearingStep = 15;
  const { pt } = constrain([10, 2], [0, 0], null, cs);
  near(Math.atan2(pt[1], pt[0]), (15 * Math.PI) / 180, 1e-12);
});

test("undo and redo restore geometry and source", () => {
  const doc = fromGeoJSON(square);
  const h = new History(doc);
  const before = JSON.stringify(toGeoJSON(doc));
  h.run({ op: "move", fid: "a", ri: 0, vi: 2, to: [1012, 1011] });
  h.run({ op: "insert", fid: "a", ri: 0, vi: 1, xy: [1005, 998] });
  h.run({ op: "delete", fid: "l", ri: 0, vi: 0 });
  h.run({ op: "remove", feature: JSON.parse(JSON.stringify(featureById(doc, "l"))) });
  const after = JSON.stringify(toGeoJSON(doc));
  while (h.undo());
  assert.equal(JSON.stringify(toGeoJSON(doc)), before);
  while (h.redo());
  assert.equal(JSON.stringify(toGeoJSON(doc)), after);
  assert.equal(h.log().split("\n").length, 4);
});

test("a batch undoes as one", () => {
  const doc = fromGeoJSON(square);
  const h = new History(doc);
  const before = JSON.stringify(toGeoJSON(doc));
  h.run({ op: "batch", ops: [
    { op: "move", fid: "a", ri: 0, vi: 0, to: [999, 999] },
    { op: "move", fid: "a", ri: 0, vi: 1, to: [1011, 999] },
  ] });
  h.undo();
  assert.equal(JSON.stringify(toGeoJSON(doc)), before);
  h.redo();
  assert.deepEqual(featureById(doc, "a").rings[0].xy[1], [1011, 999]);
});

test("a hard nudge densifies, pushes to the rim and keeps the rest as read", () => {
  const gj = { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[1000, 0], [1010, 0]] } };
  const doc = fromGeoJSON(gj);
  const f = doc.features[0];
  const w = nudgeStart(f.rings[0]);
  const c = [1005, -0.5], r = 1;
  assert.ok(nudgeStep(w, c, r, 0.1, 1) > 0);
  for (const p of w.xy) assert.ok(Math.hypot(p[0] - c[0], p[1] - c[1]) >= r - 1e-9);
  const after = finishNudge(w);
  assert.ok(after.xy.length > 2 && after.xy.length < 30); // only the moved new vertices stay
  const op = { op: "reshape", fid: f.id, ri: 0, before: { xy: f.rings[0].xy.map((p) => p.slice()), src: f.rings[0].src.slice() }, after };
  const h = new History(doc);
  h.record(apply(doc, op));
  const out = toGeoJSON(doc).features[0].geometry.coordinates;
  assert.deepEqual(out[0], [1000, 0]);
  assert.deepEqual(out.at(-1), [1010, 0]);
  near(Math.max(...out.map((p) => p[1])), 0.5, 1e-9); // the bulge top sits on the rim
  h.undo();
  assert.deepEqual(toGeoJSON(doc).features[0].geometry.coordinates, [[1000, 0], [1010, 0]]);
});

test("a smudge carries vertices with the pointer, fading to the rim", () => {
  const w = nudgeStart({ closed: false, xy: [[0, 0], [1, 0], [3, 0]], src: [null, null, null] });
  nudgeStep(w, [0, 0], 2, 0, 1, "smudge", [0, 1]);
  nearPt(w.xy[0], [0, 1]);
  near(w.xy[1][1], (1 - 0.25) ** 2);
  nearPt(w.xy[2], [3, 0]);
});

test("crossings are found, and a nudge that keeps rings simple stops at the other edge", () => {
  assert.equal(crossings([{ closed: true, xy: [[0, 0], [2, 0], [0, 2], [2, 2]] }]).length, 1); // a bow tie
  assert.equal(crossings([{ closed: true, xy: [[0, 0], [2, 0], [2, 2], [0, 2]] }]).length, 0);
  // a C shape: two arms with a gap between y = 1 and y = 2
  const ring = () => ({ closed: true, xy: [[0, 0], [10, 0], [10, 1], [1, 1], [1, 2], [10, 2], [10, 3], [0, 3]], src: Array(8).fill(null) });
  const smudge = (keep) => {
    const w = nudgeStart(ring());
    // the ball reaches the lower wall only, and carries it 2 up
    nudgeStep(w, [5, 1], 0.9, 0.1, 1, "smudge", [0, 2], keep ? [w] : null);
    return w;
  };
  assert.ok(crossings([smudge(false)]).length > 0); // pushed through the upper arm
  const w = smudge(true);
  assert.equal(crossings([w]).length, 0);
  assert.ok(Math.max(...w.xy.filter((p) => p[0] > 2 && p[0] < 9 && p[1] < 2).map((p) => p[1])) > 1.9); // it moved, up to the wall
});

test("loxodromes: meridians and parallels, round trips, constant heading", () => {
  // along a meridian a loxodrome is the geodesic
  const m = rhumbInverse(147, -42, 147, -66), g = inverse(147, -42, 147, -66);
  near(m.s, g.s, 1e-3); near(m.az, 180, 1e-12);
  // along a parallel: the arc of the parallel, heading east
  const p = rhumbInverse(100, -60, 101, -60);
  const N = 6378137 / Math.sqrt(1 - 0.0066943799901413165 * Math.sin(-Math.PI / 3) ** 2);
  near(p.s, (N * Math.cos(Math.PI / 3) * Math.PI) / 180, 1e-6); near(p.az, 90, 1e-9);
  // longer than the geodesic between the same points, and back again
  const a = [147.33, -42.88], b = [110.53, -66.28];
  const r = rhumbInverse(a[0], a[1], b[0], b[1]);
  assert.ok(r.s > inverse(a[0], a[1], b[0], b[1]).s);
  nearPt(rhumbDirect(a[0], a[1], r.az, r.s), b, 1e-9);
  // the heading holds: every piece has the same azimuth
  const q = rhumbDirect(a[0], a[1], r.az, r.s / 3);
  near(rhumbInverse(q[0], q[1], b[0], b[1]).az, r.az, 1e-9);
  // and a geo's edge model switches what lineDirect follows
  const geo = makeGeo((x) => x, (x) => x);
  nearPt(geo.lineDirect(a, r.az, r.s), direct(a[0], a[1], r.az, r.s));
  geo.line = "rhumb";
  nearPt(geo.lineDirect(a, r.az, r.s), b, 1e-9);
});

test("parametric shapes: circles, arcs, rectangles, on the grid and the ground", () => {
  const k = circle3([1, 0], [0, 1], [-1, 0]);
  nearPt(k.c, [0, 0]); near(k.r, 1);
  assert.equal(circle3([0, 0], [1, 1], [2, 2]), null);
  near(arc3([1, 0], [0, 1], [-1, 0]).sweep, Math.PI);
  near(arc3([1, 0], [0, -1], [-1, 0]).sweep, -Math.PI);
  const nat = makeFrame("native");
  const c4 = shapeRing({ kind: "circle", c: [0, 0], r: 10, n: 4 }, nat);
  [[0, 10], [10, 0], [0, -10], [-10, 0]].forEach((q, i) => nearPt(c4.xy[i], q));
  const arc = shapeRing({ kind: "arc", a: [1, 0], b: [0, 1], c: [-1, 0], n: 8 }, nat);
  assert.equal(arc.xy.length, 9);
  for (const p of arc.xy) { near(Math.hypot(p[0], p[1]), 1); assert.ok(p[1] >= -1e-12); }
  // a rectangle dragged up and to the left, axis north: corner kept, sides positive
  const r = shapeFromDrag("rect", [0, 0], [-3, 4], { az: 0 });
  assert.ok(r.w > 0 && r.h > 0);
  const ring = shapeRing(r, nat).xy;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  near(Math.min(...xs), -3); near(Math.max(...xs), 0); near(Math.min(...ys), 0); near(Math.max(...ys), 4);
  // on the ground: a 500 m circle about Hobart in a local plane is 500 m on the ellipsoid
  const loc = makeFrame("local", 147.3, -42.9), geo = makeGeo(loc.toLL, loc.fromLL);
  const g = shapeFromDrag("circle", loc.fwd([147.3, -42.9]), loc.fwd([147.3, -42.9 + 0.0045]), { n: 36, ground: true }, geo, loc.inv);
  near(g.r, inverse(147.3, -42.9, 147.3, -42.9 + 0.0045).s, 1e-6);
  for (const p of shapeRing(g, loc, geo).xy) { const q = loc.inv(p); near(inverse(147.3, -42.9, q[0], q[1]).s, g.r, 1e-5); }
});

test("a shaped feature becomes plain geometry when a vertex moves, and undo restores it", () => {
  const doc = fromGeoJSON({ type: "FeatureCollection", features: [] });
  const shape = { kind: "circle", c: [1000, 1000], r: 10, n: 6 };
  const xy = shapeRing(shape, doc.frame).xy;
  const h = new History(doc);
  h.run({ op: "add", feature: { id: "c", type: "Polygon", props: { [SHAPE_KEY]: shape }, rings: [{ part: 0, closed: true, xy, src: xy.map(() => null) }] } });
  // the shape's own edit keeps it
  const r2 = { ...shape, r: 20 }, xy2 = shapeRing(r2, doc.frame).xy;
  h.run({ op: "batch", keepShape: true, ops: [
    { op: "reshape", fid: "c", ri: 0, before: { xy, src: xy.map(() => null) }, after: { xy: xy2, src: xy2.map(() => null) } },
    { op: "props", fid: "c", before: { [SHAPE_KEY]: shape }, after: { [SHAPE_KEY]: r2 } }] });
  near(featureById(doc, "c").props[SHAPE_KEY].r, 20);
  h.run({ op: "move", fid: "c", ri: 0, vi: 0, to: [1000, 1030] });
  assert.ok(!(SHAPE_KEY in featureById(doc, "c").props));
  h.undo();
  near(featureById(doc, "c").props[SHAPE_KEY].r, 20);
  nearPt(featureById(doc, "c").rings[0].xy[0], xy2[0]);
  h.undo();
  near(featureById(doc, "c").props[SHAPE_KEY].r, 10);
});

test("Vincenty: Flinders Peak to Buninyong", () => {
  const dms = (d, m, s) => Math.sign(d) * (Math.abs(d) + m / 60 + s / 3600);
  const p = [dms(144, 25, 29.5244), dms(-37, 57, 3.7203)], q = [dms(143, 55, 35.3839), dms(-37, 39, 10.1561)];
  const g = inverse(p[0], p[1], q[0], q[1]);
  near(g.s, 54972.271, 1e-3);
  near(g.az1, dms(306, 52, 5.37), 1e-5);
  const b = direct(p[0], p[1], g.az1, g.s);
  near(b[0], q[0], 1e-9); near(b[1], q[1], 1e-9);
});

// A local plane turned so that true north lies 10 degrees clockwise of
// grid north: grid north is 10 degrees anticlockwise of true north, a
// convergence of -10.
function turnedGeo(turn) {
  const R = 6371008.8, d = (Math.PI / 180) * R, lat0 = -42, k = Math.cos((lat0 * Math.PI) / 180);
  const c = Math.cos((turn * Math.PI) / 180), s = Math.sin((turn * Math.PI) / 180);
  const fromLL = (ll) => { const x = (ll[0] - 147) * d * k, y = (ll[1] - lat0) * d; return [c * x + s * y, -s * x + c * y]; };
  const toLL = (p) => { const x = c * p[0] - s * p[1], y = s * p[0] + c * p[1]; return [147 + x / (d * k), lat0 + y / d]; };
  return makeGeo(toLL, fromLL);
}

test("grid convergence and true-north locks", () => {
  const geo = turnedGeo(10);
  near(geo.convergence([0, 0]), -10, 0.05);
  const cs = cs0();
  cs.conv = "bearing"; cs.north = "true"; cs.a = { on: true, val: 0, rel: false }; cs.d = { on: true, val: 100 };
  const { pt } = constrain([0, 50], [0, 0], null, cs, null, geo);
  near(90 - (Math.atan2(pt[1], pt[0]) * 180) / Math.PI, 10, 0.05); // true north, drawn 10 deg right of grid north
  cs.measure = "ground";
  const g = constrain([0, 50], [0, 0], null, cs, null, geo).pt;
  near(geo.distance([0, 0], g), 100, 1e-6); // exactly 100 m on the ellipsoid
});

test("snapping follows geodesic edges when asked", () => {
  const doc = fromGeoJSON({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [[140, -60], [160, -60]] } });
  const geo = makeGeo(doc.frame.toLL, doc.frame.fromLL);
  const opts = { segment: true, curve: (a, b) => geo.curve(a, b, 5000), curveKey: "g" };
  const r = doc.features[0].rings[0];
  const mid = [(r.xy[0][0] + r.xy[1][0]) / 2, r.xy[0][1]];
  // the geodesic bows poleward of the straight grid line at mid-span
  const s = snap(doc, [mid[0], mid[1] - 200000], 300000, opts);
  // geodesic vertex latitude: tan(lat) = tan(60) / cos(10), about 60.37 S
  const ym = doc.frame.fromLL([150, -Math.atan(Math.tan(Math.PI / 3) / Math.cos(Math.PI / 18)) * 180 / Math.PI])[1];
  near(s.pt[1], ym, 200); // on the curve (spherical estimate vs WGS84), about 41 km south of the grid line
  assert.ok(ym < mid[1] - 40000);
});

test("transects, cover, clip and a lawnmower track on the grid", () => {
  const t = transects([0, 0], { az: 0, spacing: 10, length: 100, count: 3 });
  nearPt(t[2][0], [20, 0], 1e-9); nearPt(t[2][1], [20, 100], 1e-9);
  const square = [[[0, 0], [50, 0], [50, 30], [0, 30]]];
  const c = cover([0, 0], square, { az: 0, spacing: 10 });
  assert.equal(c.length, 6);
  nearPt(c[5][0], [50, 0], 1e-9); nearPt(c[5][1], [50, 30], 1e-9);
  const pieces = clip([[5, -10], [5, 40]], square);
  assert.equal(pieces.length, 1);
  nearPt(pieces[0][0], [5, 0], 1e-9); nearPt(pieces[0][1], [5, 30], 1e-9);
  const hole = [[[0, 0], [50, 0], [50, 30], [0, 30]], [[2, 10], [8, 10], [8, 20], [2, 20]]];
  assert.equal(clip([[5, -10], [5, 40]], hole).length, 2);
  const lm = lawnmower(t);
  nearPt(lm[2], [10, 100], 1e-9); nearPt(lm[3], [10, 0], 1e-9);
});

test("ground transects and repeats keep their metres", () => {
  const geo = turnedGeo(25);
  const t = transects([1000, 2000], { az: 30, spacing: 250, length: 5000, count: 4 }, geo);
  for (let i = 0; i + 1 < t.length; i++) near(geo.distance(t[i][0], t[i + 1][0]), 250, 1e-5); // micrometres: round trips through the frame
  for (const [a, b] of t) near(geo.distance(a, b), 5000, 1e-6);
  const g0 = geo.toLL(t[0][0]), g1 = geo.toLL(t[0][1]);
  near(inverse(g0[0], g0[1], g1[0], g1[1]).az1, 30, 1e-9);
  const copies = repeat([[[0, 0], [10, 0], [10, 10]]], { az: 90, step: 40, count: 2 }, geo);
  near(geo.distance([0, 0], copies[1][0][0]), 80, 1e-6);
});

console.log(`${n} tests passed`);
