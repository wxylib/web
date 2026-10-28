// Tests for www/edit-core.js: node scripts/edit-core-test.mjs
import assert from "node:assert/strict";
import {
  fromGeoJSON, toGeoJSON, snap, constrain, History, toTheta, fromTheta, featureById,
  nudgeStart, nudgeStep, finishNudge, apply,
} from "../www/edit-core.js";

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

console.log(`${n} tests passed`);
