// The editing canvas: drawing, the pointer and the panels. Geometry,
// snapping, constraints and operations are in edit-core.js.

import {
  fromGeoJSON, toGeoJSON, featureById, docBbox, snap, constrain, prevDirection, segments,
  History, canDelete, newFeature, closestOnSegment, pointInRing, ringArea, ringLength,
  dist, fromTheta, add, mul, sub, touch, apply, nudgeStart, nudgeStep, finishNudge,
  makeFrame, reframe, segmentPaths, bboxOf,
} from "./edit-core.js";
import { makeGeo, direct, inverse } from "./edit-geo.js";

// wxylib in wasm (proj4rs transforms, COG warp), when it has been built
// into ./pkg; without it the canvas still edits, in data coordinates or
// a local plane.
let wasm = null;
const wasmReady = import("./pkg/wxy_web.js")
  .then(async (m) => { await m.default(); wasm = m; return m; })
  .catch((e) => { console.warn("wxy_web wasm not available:", e); return null; });

const $ = (id) => document.getElementById(id);
const cv = $("cv");
const ctx = cv.getContext("2d");

const S = {
  doc: null, hist: null,
  view: { cx: 0, cy: 0, scale: 1 }, // scale: frame units per CSS pixel
  w: 0, h: 0,
  mode: "edit",
  sel: null,          // { fid, ri, vi } (ri, vi null when only the feature is selected)
  drag: null,         // { kind: "vertex" | "mid" | "pan", ... }
  draft: [],          // vertices of the shape being drawn
  mouse: null,        // pointer in screen pixels
  hit: null,          // { snap, pt, guides } at the pointer
  pending: null,      // "perp" | "para": the next click picks a segment
  space: false,
};

const drawingMode = () => S.mode === "Point" || S.mode === "LineString" || S.mode === "Polygon";

// ---- view transforms -------------------------------------------------------

const toScreen = (p) => [(p[0] - S.view.cx) / S.view.scale + S.w / 2, S.h / 2 - (p[1] - S.view.cy) / S.view.scale];
const toWorld = (s) => [S.view.cx + (s[0] - S.w / 2) * S.view.scale, S.view.cy - (s[1] - S.h / 2) * S.view.scale];

function resize() {
  const r = cv.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  S.w = r.width; S.h = r.height;
  cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (S.needFit) fit(); else draw();
}

function fit() {
  if (!S.doc || !S.doc.features.length) return;
  S.needFit = !(S.w > 0 && S.h > 0);
  if (S.needFit) return;
  const [x0, y0, x1, y1] = docBbox(S.doc);
  S.view.cx = (x0 + x1) / 2; S.view.cy = (y0 + y1) / 2;
  S.view.scale = Math.max((x1 - x0) / (S.w * 0.85), (y1 - y0) / (S.h * 0.85), 1e-9);
  draw();
}

// ---- data ----------------------------------------------------------------------

async function setDoc(gj, name, srcCrs = null) {
  S.doc = fromGeoJSON(gj);
  S.hist = new History(S.doc);
  S.sel = null; S.draft = []; S.hit = null;
  S.name = name;
  $("srcCrs").value = srcCrs || (S.doc.frame.kind === "local" ? "EPSG:4326" : "");
  status("");
  await wasmReady;
  applyFrame(true);
  panels();
}

// ---- the frame: which plane edits happen in, and how it meets the ground ----

const isLonLat = (crs) => /^(EPSG:4326|EPSG:4283|EPSG:7844|OGC:CRS84|\+proj=(longlat|lonlat|latlong))/i.test(crs.trim());
const two = (v) => [v[0], v[1]];

function sourceCentre() {
  const pts = S.doc.features.flatMap((f) => f.rings.flatMap((r) => r.src.filter(Boolean)));
  const [x0, y0, x1, y1] = bboxOf(pts);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

// Build the frame from the data CRS and the edit CRS fields and move the
// document into it. Edits made so far travel with it.
function applyFrame(refit = false) {
  if (!S.doc) return;
  const src = $("srcCrs").value.trim(), dst = $("editCrs").value.trim();
  let frame, geo = null;
  try {
    if (src && dst) {
      if (!wasm) throw new Error("the wasm module is not built, so only the local plane is available");
      const tf = new wasm.Transform(src, dst), tl = new wasm.Transform(dst, "EPSG:4326");
      frame = { kind: "crs", crs: dst, label: dst,
        fwd: (p) => two(tf.forward([p[0], p[1]])), inv: (p) => two(tf.inverse([p[0], p[1]])) };
      geo = makeGeo((p) => two(tl.forward([p[0], p[1]])), (ll) => two(tl.inverse([ll[0], ll[1]])));
    } else if (src && isLonLat(src)) {
      const [lon0, lat0] = sourceCentre();
      frame = makeFrame("local", lon0, lat0);
      frame.crs = `+proj=eqc +lat_ts=${lat0} +lat_0=${lat0} +lon_0=${lon0} +R=6371008.8 +units=m +no_defs`;
      geo = makeGeo(frame.toLL, frame.fromLL);
    } else {
      frame = makeFrame("native");
      if (src && wasm) {
        const tl = new wasm.Transform(src, "EPSG:4326");
        frame.crs = src; frame.label = `data coordinates, ${src}`;
        geo = makeGeo((p) => two(tl.forward([p[0], p[1]])), (ll) => two(tl.inverse([ll[0], ll[1]])));
      }
    }
  } catch (e) {
    status("Frame: " + (e.message || e), true);
    return;
  }
  const before = S.doc.frame;
  reframe(S.doc, frame);
  // the log's coordinates are in the old frame: the edits stay, the log starts again
  if (S.hist.done.length && before.crs !== frame.crs) {
    S.hist = new History(S.doc);
    status("New frame: the edits made so far are kept; undo and the log start again here.");
  }
  S.geo = geo;
  $("frame").textContent = `${S.name}: ${S.doc.features.length} features. Edit frame: ${frame.label}.` +
    (geo ? "" : " No CRS, so ground measures are off.");
  for (const id of ["measure", "north", "edges"]) $(id).disabled = !geo;
  if (refit || before.kind !== frame.kind || before.crs !== frame.crs) fit();
  S.under = null; requestUnderlay();
  draw();
}

// The UTM zone at the data's centre.
function utmZone() {
  if (!S.doc) return;
  const src = $("srcCrs").value.trim();
  let ll = sourceCentre();
  if (!isLonLat(src)) {
    if (!S.geo) { status("Set the data CRS first.", true); return; }
    ll = S.geo.toLL(S.doc.frame.fwd(ll));
  }
  const zone = Math.floor((ll[0] + 180) / 6) + 1;
  $("editCrs").value = `EPSG:${ll[1] < 0 ? 327 : 326}${String(zone).padStart(2, "0")}`;
  applyFrame();
}

// Six parcels on a block turned 7 degrees, a road, a creek and four
// trees, in metres on a projected grid (MGA zone 55 sized numbers).
// Synthetic: made here so the page works with no network.
function sampleParcels() {
  const O = [526100, 5251700], t = (7 * Math.PI) / 180;
  const P = (u, v) => [+(O[0] + u * Math.cos(t) - v * Math.sin(t)).toFixed(3), +(O[1] + u * Math.sin(t) + v * Math.cos(t)).toFixed(3)];
  const feats = [];
  let lot = 1;
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      const u0 = col * 24, v0 = row * 40;
      feats.push({ type: "Feature", id: "lot" + lot, properties: { kind: "parcel", lot: lot++ },
        geometry: { type: "Polygon", coordinates: [[P(u0, v0), P(u0 + 24, v0), P(u0 + 24, v0 + 40), P(u0, v0 + 40), P(u0, v0)]] } });
    }
  }
  feats.push({ type: "Feature", id: "road", properties: { kind: "road centreline" },
    geometry: { type: "LineString", coordinates: [P(-30, -8), P(30, -8), P(102, -8)] } });
  const creek = [];
  for (let i = 0; i <= 16; i++) {
    const u = -20 + i * 7;
    creek.push(P(u, 95 - i * 2.2 + 4 * Math.sin(i * 0.9)));
  }
  feats.push({ type: "Feature", id: "creek", properties: { kind: "creek" }, geometry: { type: "LineString", coordinates: creek } });
  [[10, 55], [36, 62], [60, 20], [-12, 30]].forEach(([u, v], i) =>
    feats.push({ type: "Feature", id: "tree" + (i + 1), properties: { kind: "tree" }, geometry: { type: "Point", coordinates: P(u, v) } }));
  return { type: "FeatureCollection", features: feats };
}

async function loadUrl(url) {
  status("Fetching " + url);
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    setDoc(await r.json(), url.split("/").pop() || url);
  } catch (e) {
    status("Could not load: " + e.message, true);
  }
}

function loadFile(file) {
  file.text().then((t) => setDoc(JSON.parse(t), file.name)).catch((e) => status("Could not read: " + e.message, true));
}

function status(msg, err = false) {
  $("status").textContent = msg;
  $("status").classList.toggle("error", err);
}

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- options and constraints from the panel -------------------------------------

function snapOpts() {
  return {
    vertex: $("sVertex").checked, segment: $("sSegment").checked, middle: $("sMiddle").checked,
    intersection: $("sInter").checked, grid: $("sGrid").checked, gridStep: +$("gridStep").value || 0,
    ...edgeOpts(),
  };
}

// Geodesic edges: each segment drawn and snapped as the geodesic between
// its vertices, densified to about 4 pixels.
function edgeOpts() {
  if (!S.geo || $("edges").value !== "geodesic") return {};
  const geo = S.geo, maxLen = 4 * S.view.scale;
  return {
    curve: (a, b) => geo.curve(a, b, maxLen),
    curveKey: "g" + maxLen.toPrecision(2),
    mid: (a, b) => {
      const p = geo.toLL(a), q = geo.toLL(b), g = inverse(p[0], p[1], q[0], q[1]);
      return g ? geo.fromLL(direct(p[0], p[1], g.az1, g.s / 2)) : mul(add(a, b), 0.5);
    },
  };
}

// The middle of a segment: of the geodesic when edges are geodesics.
function midOf(a, b) {
  const eo = edgeOpts();
  return eo.mid ? eo.mid(a, b) : mul(add(a, b), 0.5);
}

function touchAll() { if (S.doc) for (const f of S.doc.features) touch(f); }

function constraints() {
  const num = (id) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : 0; };
  return {
    conv: $("conv").value,
    d: { on: $("ld").checked, val: num("cd") },
    a: { on: $("la").checked, val: num("ca"), rel: $("ra").checked },
    x: { on: $("lx").checked, val: num("cx"), rel: $("rx").checked },
    y: { on: $("ly").checked, val: num("cy"), rel: $("ry").checked },
    bearingStep: +$("bearing").value, bearingRel: $("bearingRel").checked,
    measure: $("measure").value, north: $("north").value,
  };
}

const LOCKS = { d: "ld", a: "la", x: "lx", y: "ly" };
const FIELDS = { d: "cd", a: "ca", x: "cx", y: "cy" };

function anyLocked() { return Object.values(LOCKS).some((id) => $(id).checked); }

function unlockAll() {
  for (const id of Object.values(LOCKS)) $(id).checked = false;
  lockStyle();
}

function lockStyle() {
  for (const k of Object.keys(LOCKS)) $(FIELDS[k]).classList.toggle("locked", $(LOCKS[k]).checked);
}

// ---- the pointer: snap, then constrain -----------------------------------------------

// The reference point and the direction before it for whatever is being
// placed: the previous vertex of the draft, or of the dragged vertex.
function reference() {
  if (drawingMode() && S.draft.length) {
    const n = S.draft.length;
    return { ref: S.draft[n - 1], prev: prevDirection(S.draft, n - 1, false) };
  }
  if (S.drag && (S.drag.kind === "vertex" || S.drag.kind === "mid")) {
    const r = featureById(S.doc, S.drag.fid).rings[S.drag.ri];
    const xy = r.xy, n = xy.length;
    let j = S.drag.kind === "mid" ? S.drag.vi - 1 : S.drag.vi - 1;
    if (j < 0) { if (!r.closed) return { ref: null, prev: null }; j = n - 1; }
    return { ref: xy[j], prev: prevDirection(xy, j, r.closed) };
  }
  return { ref: null, prev: null };
}

function pointer(sx, sy) {
  const w = toWorld([sx, sy]);
  const tol = (+$("tol").value || 12) * S.view.scale;
  let sn = null;
  if (S.doc && $("snapOn").checked) {
    let skip = () => false, skipSeg = () => false;
    if (S.drag && S.drag.kind === "vertex") {
      const d = S.drag;
      skip = (f, r, i) => isDragged(d, f, r, i);
      skipSeg = (f, r, i, j) => isDragged(d, f, r, i) || isDragged(d, f, r, j);
    } else if (S.drag && S.drag.kind === "mid") {
      const { fid, ri, a, b } = S.drag;
      skipSeg = (f, r, i, j) => f === fid && r === ri && i === a && j === b;
    }
    const extra = drawingMode() && S.draft.length ? [{ xy: S.draft, closed: false }] : [];
    sn = snap(S.doc, w, tol, snapOpts(), skip, skipSeg, extra);
  }
  const cursor = sn ? sn.pt : w;
  const placing = S.drag ? S.drag.kind === "vertex" || S.drag.kind === "mid" : drawingMode();
  let pt = cursor, guides = [];
  if (placing) {
    const { ref, prev } = reference();
    const c = constrain(cursor, ref, prev, constraints(), sn && sn.seg ? sn.seg : null, S.geo);
    pt = c.pt; guides = c.guides;
  }
  S.hit = { snap: sn, pt, guides, raw: w };
}

// Vertices of other rings at exactly the same place: with "move shared
// vertices" on they travel with the dragged one, so a boundary two
// parcels share stays shared.
function sharedWith(fid, ri, vi) {
  if (!$("topo").checked) return [];
  const p = featureById(S.doc, fid).rings[ri].xy[vi];
  const out = [];
  for (const f of S.doc.features) {
    f.rings.forEach((r, rj) => r.xy.forEach((q, j) => {
      if ((f.id !== fid || rj !== ri || j !== vi) && q[0] === p[0] && q[1] === p[1]) out.push({ fid: f.id, ri: rj, vi: j });
    }));
  }
  return out;
}

const isDragged = (d, f, r, i) => (f === d.fid && r === d.ri && i === d.vi) || d.shared.some((s) => s.fid === f && s.ri === r && s.vi === i);

// ---- hit tests in edit mode ----------------------------------------------------------

function hitVertex(s) {
  if (!S.sel) return null;
  const f = featureById(S.doc, S.sel.fid);
  const tol = 8;
  for (let ri = 0; ri < f.rings.length; ri++) {
    const xy = f.rings[ri].xy;
    for (let vi = 0; vi < xy.length; vi++) {
      const p = toScreen(xy[vi]);
      if (Math.abs(p[0] - s[0]) <= tol && Math.abs(p[1] - s[1]) <= tol) return { ri, vi };
    }
  }
  return null;
}

function hitMid(s) {
  if (!S.sel) return null;
  const f = featureById(S.doc, S.sel.fid);
  for (let ri = 0; ri < f.rings.length; ri++) {
    const r = f.rings[ri];
    for (const [a, b] of segments(r)) {
      const m = toScreen(midOf(r.xy[a], r.xy[b]));
      if (Math.hypot(m[0] - s[0], m[1] - s[1]) <= 7) return { ri, a, b };
    }
  }
  return null;
}

function hitSegment(s, fid = null) {
  const w = toWorld(s);
  const tol = 8 * S.view.scale;
  let best = null;
  const eo = edgeOpts();
  for (const f of S.doc.features) {
    if (fid && f.id !== fid) continue;
    f.rings.forEach((r, ri) => {
      const paths = segmentPaths(r, eo);
      segments(r).forEach(([a, b], k) => {
        const path = paths[k];
        for (let m = 0; m + 1 < path.length; m++) {
          const c = closestOnSegment(w, path[m], path[m + 1]);
          if (c.d <= tol && (!best || c.d < best.d)) best = { fid: f.id, ri, a, b, pt: c.pt, d: c.d, seg: [path[m], path[m + 1]] };
        }
      });
    });
  }
  return best;
}

function hitFeature(s) {
  const w = toWorld(s);
  const tol = 8 * S.view.scale;
  // points and lines first (they sit on top), then polygon interiors, last drawn first
  for (let k = S.doc.features.length - 1; k >= 0; k--) {
    const f = S.doc.features[k];
    for (const r of f.rings) {
      if (r.xy.length === 1 && dist(r.xy[0], w) <= tol) return f.id;
    }
  }
  const seg = hitSegment(s);
  if (seg) return seg.fid;
  for (let k = S.doc.features.length - 1; k >= 0; k--) {
    const f = S.doc.features[k];
    if (!f.type.endsWith("Polygon")) continue;
    // inside an outer ring and not inside its holes: count crossings over all rings
    let inside = false;
    for (const r of f.rings) if (pointInRing(w, r.xy)) inside = !inside;
    if (inside) return f.id;
  }
  return null;
}

// ---- mouse ------------------------------------------------------------------------------

cv.addEventListener("contextmenu", (e) => e.preventDefault());

cv.addEventListener("mousedown", (e) => {
  cv.focus();
  if (!S.doc) return;
  const s = [e.offsetX, e.offsetY];
  if (e.button !== 0 || S.space) {
    S.drag = { kind: "pan", s0: s, c0: [S.view.cx, S.view.cy] };
    return;
  }
  if (S.pending) {
    const seg = hitSegment(s);
    if (seg) {
      const th = Math.atan2(seg.seg[1][1] - seg.seg[0][1], seg.seg[1][0] - seg.seg[0][0]) + (S.pending === "perp" ? Math.PI / 2 : 0);
      $("ca").value = String(fromTheta(th, $("conv").value));
      $("ra").checked = false;
      $("la").checked = true;
      lockStyle();
      status(`Angle locked ${S.pending === "perp" ? "perpendicular" : "parallel"} to a segment of ${seg.fid}.`);
    }
    S.pending = null;
    pointer(s[0], s[1]); draw();
    return;
  }
  if (S.mode === "nudge") {
    if (!S.sel) {
      const fid = hitFeature(s);
      if (!fid) return;
      S.sel = { fid, ri: null, vi: null };
    }
    const f = featureById(S.doc, S.sel.fid);
    S.drag = { kind: "nudge", fid: f.id, w: f.rings.map(nudgeStart),
      before: f.rings.map((r) => ({ xy: r.xy.map((p) => p.slice()), src: r.src.slice() })), last: toWorld(s) };
    nudge(s, e.shiftKey);
    panels(); draw();
    return;
  }
  if (S.mode === "edit") {
    const v = hitVertex(s);
    if (v) {
      S.sel = { fid: S.sel.fid, ...v };
      S.drag = { kind: "vertex", fid: S.sel.fid, ri: v.ri, vi: v.vi, moved: false, shared: sharedWith(S.sel.fid, v.ri, v.vi) };
      panels(); return;
    }
    const m = hitMid(s);
    if (m) {
      S.drag = { kind: "mid", fid: S.sel.fid, ri: m.ri, a: m.a, b: m.b, vi: m.a + 1, moved: false };
      return;
    }
    const fid = hitFeature(s);
    S.sel = fid ? { fid, ri: null, vi: null } : null;
    panels(); draw();
    return;
  }
  // drawing
  pointer(s[0], s[1]);
  const p = S.hit.pt.slice();
  if (S.mode === "Point") {
    commitNew("Point", [p]);
    return;
  }
  if (S.mode === "Polygon" && S.draft.length >= 3) {
    const first = toScreen(S.draft[0]), q = toScreen(p);
    if (Math.hypot(first[0] - q[0], first[1] - q[1]) <= 8) { finishDraft(); return; }
  }
  S.draft.push(p);
  afterPlace();
  pointer(s[0], s[1]); draw();
});

cv.addEventListener("mousemove", (e) => {
  S.mouse = [e.offsetX, e.offsetY];
  if (!S.doc) return;
  if (S.drag && S.drag.kind === "pan") {
    S.view.cx = S.drag.c0[0] - (e.offsetX - S.drag.s0[0]) * S.view.scale;
    S.view.cy = S.drag.c0[1] + (e.offsetY - S.drag.s0[1]) * S.view.scale;
    draw(); return;
  }
  if (S.drag && S.drag.kind === "nudge") { nudge([e.offsetX, e.offsetY], e.shiftKey); draw(); return; }
  if (S.mode === "nudge") { S.hit = { snap: null, pt: toWorld(S.mouse), guides: [] }; draw(); return; }
  if (S.drag) S.drag.moved = true;
  pointer(e.offsetX, e.offsetY);
  draw();
});

window.addEventListener("mouseup", () => {
  const d = S.drag;
  S.drag = null;
  if (d && d.kind === "nudge") { endNudge(d); return; }
  if (!d || d.kind === "pan" || !d.moved || !S.hit) { draw(); return; }
  const to = S.hit.pt.slice();
  if (d.kind === "vertex") {
    const moves = [d, ...d.shared].map((v) => ({ op: "move", fid: v.fid, ri: v.ri, vi: v.vi, to }));
    S.hist.run(moves.length > 1 ? { op: "batch", ops: moves } : moves[0]);
  } else {
    S.hist.run({ op: "insert", fid: d.fid, ri: d.ri, vi: d.b === 0 ? featureById(S.doc, d.fid).rings[d.ri].xy.length : d.a + 1, xy: to });
    S.sel = { fid: d.fid, ri: d.ri, vi: d.b === 0 ? featureById(S.doc, d.fid).rings[d.ri].xy.length - 1 : d.a + 1 };
  }
  afterPlace();
  panels(); draw();
});

cv.addEventListener("dblclick", (e) => {
  if (!S.doc) return;
  const s = [e.offsetX, e.offsetY];
  if (S.mode === "edit" && S.sel) {
    const seg = hitSegment(s, S.sel.fid);
    if (seg && !hitVertex(s)) {
      const ring = featureById(S.doc, seg.fid).rings[seg.ri];
      const vi = seg.b === 0 ? ring.xy.length : seg.a + 1;
      S.hist.run({ op: "insert", fid: seg.fid, ri: seg.ri, vi, xy: seg.pt });
      S.sel = { fid: seg.fid, ri: seg.ri, vi };
      panels(); draw();
    }
  } else if (S.mode === "LineString" || S.mode === "Polygon") {
    // the second click of the double click added a vertex on top of the first
    const n = S.draft.length;
    if (n >= 2 && dist(S.draft[n - 1], S.draft[n - 2]) <= 2 * S.view.scale) S.draft.pop();
    finishDraft();
  }
});

cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const before = toWorld([e.offsetX, e.offsetY]);
  S.view.scale *= Math.exp(e.deltaY * 0.0015);
  const after = toWorld([e.offsetX, e.offsetY]);
  S.view.cx += before[0] - after[0]; S.view.cy += before[1] - after[1];
  if (S.mouse) pointer(S.mouse[0], S.mouse[1]);
  draw();
}, { passive: false });

cv.addEventListener("dragover", (e) => e.preventDefault());
cv.addEventListener("drop", (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

// ---- the underlay: a COG warped into the edit frame ---------------------------------------

// Rendering is warping to a screen grid, and here the screen grid is the
// edit frame: the COG is warped by wxy-warp straight into the frame's
// CRS for the view, whatever that CRS is.
async function loadCog(url) {
  if (!url) { S.cog = null; S.under = null; draw(); return; }
  await wasmReady;
  if (!wasm) { status("The wasm module is not built, so no underlay.", true); return; }
  status("Opening " + url);
  try {
    S.cog = await wasm.Cog.open(url);
    S.under = null;
    status("");
    requestUnderlay();
  } catch (e) {
    status("Could not open the COG: " + (e.message || e), true);
  }
}

let underTimer = null, underSeq = 0;
function requestUnderlay() {
  if (!S.cog || !S.doc || !S.doc.frame.crs) return;
  clearTimeout(underTimer);
  underTimer = setTimeout(warpUnderlay, 150);
}

async function warpUnderlay() {
  const crs = S.doc.frame.crs;
  const w = Math.max(1, Math.round(S.w)), h = Math.max(1, Math.round(S.h));
  const [x0, y1] = toWorld([0, 0]), [x1, y0] = toWorld([S.w, S.h]);
  const seq = ++underSeq;
  try {
    const out = await S.cog.warp(crs, [x0, x1, y0, y1], w, h, "bilinear");
    if (seq !== underSeq) return; // a newer view is on its way
    const img = new ImageData(w, h);
    const n = w * h, v = out.values, rgb = out.bands >= 3;
    let lo = 0, hi = 255;
    if (!rgb || Math.max(...v.subarray(0, Math.min(v.length, 4096)).filter(Number.isFinite)) > 255) {
      const sample = [];
      for (let i = 0; i < n; i += Math.max(1, Math.floor(n / 4000))) if (Number.isFinite(v[i])) sample.push(v[i]);
      sample.sort((a, b) => a - b);
      lo = sample[Math.floor(sample.length * 0.02)] ?? 0; hi = sample[Math.floor(sample.length * 0.98)] ?? 1;
    }
    const sc = (x) => Math.max(0, Math.min(255, ((x - lo) / (hi - lo || 1)) * 255));
    for (let i = 0; i < n; i++) {
      const r = v[i], g = rgb ? v[n + i] : r, b = rgb ? v[2 * n + i] : r;
      if (!Number.isFinite(r)) continue;
      img.data[4 * i] = sc(r); img.data[4 * i + 1] = sc(g); img.data[4 * i + 2] = sc(b); img.data[4 * i + 3] = 255;
    }
    const oc = document.createElement("canvas");
    oc.width = w; oc.height = h;
    oc.getContext("2d").putImageData(img, 0, 0);
    S.under = { canvas: oc, x0, y1, scale: S.view.scale, crs, level: out.level, requests: out.requests, bytes: out.bytes };
    draw();
  } catch (e) {
    status("Underlay: " + (e.message || e), true);
  }
}

// Draw the last warp where it belongs in the current view (stretched
// while a new one is fetched), then ask for a new one if the view moved.
function drawUnderlay() {
  const u = S.under;
  if (u && S.doc.frame.crs === u.crs) {
    const s = toScreen([u.x0, u.y1]);
    const k = u.scale / S.view.scale;
    ctx.save();
    ctx.globalAlpha = +$("opacity").value;
    ctx.drawImage(u.canvas, s[0], s[1], u.canvas.width * k, u.canvas.height * k);
    ctx.restore();
  }
  const key = [S.view.cx, S.view.cy, S.view.scale, S.w, S.h, S.doc.frame.crs].join();
  if (S.cog && key !== S.underKey) { S.underKey = key; requestUnderlay(); }
}

// ---- the nudge brush ----------------------------------------------------------------------

// The brush size and the densify spacing are in screen pixels, so the
// same stroke traces finer detail the further in the view is zoomed.
function nudgeOpts(shift) {
  return { r: (+$("nSize").value || 30) * S.view.scale, step: (+$("nStep").value || 4) * S.view.scale,
    power: Math.max(0, Math.min(1, +$("nPower").value)), mode: shift ? ($("nMode").value === "push" ? "smudge" : "push") : $("nMode").value };
}

function nudge(s, shift) {
  const d = S.drag;
  const c = toWorld(s);
  const o = nudgeOpts(shift);
  const f = featureById(S.doc, d.fid);
  const delta = sub(c, d.last);
  d.w.forEach((w, ri) => {
    nudgeStep(w, c, o.r, o.step, o.power, o.mode, delta);
    f.rings[ri].xy = w.xy; f.rings[ri].src = w.src; // live while the stroke lasts
  });
  touch(f);
  d.last = c;
}

// The stroke becomes one operation: a reshape of each ring it moved.
function endNudge(d) {
  const f = featureById(S.doc, d.fid);
  const ops = [];
  d.w.forEach((w, ri) => {
    f.rings[ri].xy = d.before[ri].xy.map((p) => p.slice()); f.rings[ri].src = d.before[ri].src.slice();
    if (!w.moved.some(Boolean)) return;
    ops.push({ op: "reshape", fid: f.id, ri, before: d.before[ri], after: finishNudge(w) });
  });
  touch(f);
  if (ops.length) {
    const op = ops.length > 1 ? { op: "batch", ops } : ops[0];
    S.hist.record(apply(S.doc, op));
  }
  panels(); draw();
}

function drawBrush(c) {
  if (!S.mouse) return;
  const r = +$("nSize").value || 30;
  const [x, y] = S.mouse;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, "rgba(219, 39, 119, 0.22)");
  g.addColorStop(0.75, "rgba(219, 39, 119, 0.12)");
  g.addColorStop(1, "rgba(219, 39, 119, 0)");
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(x, y, r, 0, 2 * Math.PI); ctx.fill();
  ctx.strokeStyle = c.snap; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
  ctx.stroke(); ctx.setLineDash([]);
}

// ---- placing and finishing ---------------------------------------------------------------

// After a vertex is placed, locks release unless asked to keep them.
function afterPlace() {
  if (!$("keep").checked) unlockAll();
}

function finishDraft() {
  const need = S.mode === "Polygon" ? 3 : 2;
  if (S.draft.length >= need) commitNew(S.mode, S.draft);
  else if (S.draft.length) status(`A ${S.mode === "Polygon" ? "polygon" : "line"} needs ${need} vertices.`, true);
  S.draft = [];
  draw();
}

function commitNew(type, xy) {
  const f = newFeature(S.doc, type, xy);
  S.hist.run({ op: "add", feature: f });
  S.sel = { fid: f.id, ri: null, vi: null };
  afterPlace();
  panels(); draw();
}

function deleteSelected() {
  if (!S.sel) return;
  const f = featureById(S.doc, S.sel.fid);
  if (S.sel.vi != null) {
    const r = f.rings[S.sel.ri];
    if (!canDelete(r)) { status("That would leave too few vertices; delete the feature instead.", true); return; }
    S.hist.run({ op: "delete", fid: f.id, ri: S.sel.ri, vi: S.sel.vi });
    S.sel = { fid: f.id, ri: null, vi: null };
  } else {
    S.hist.run({ op: "remove", feature: JSON.parse(JSON.stringify(f, (k, v) => (k === "_bb" ? undefined : v))) });
    S.sel = null;
  }
  panels(); draw();
}

function undo() { if (S.hist && S.hist.undo()) { fixSel(); panels(); draw(); } }
function redo() { if (S.hist && S.hist.redo()) { fixSel(); panels(); draw(); } }
function fixSel() {
  if (!S.sel) return;
  const f = featureById(S.doc, S.sel.fid);
  if (!f) S.sel = null;
  else if (S.sel.vi != null && (!f.rings[S.sel.ri] || S.sel.vi >= f.rings[S.sel.ri].xy.length)) S.sel.vi = S.sel.ri = null;
}

// ---- keys -------------------------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement;
  if (inField) {
    const key = Object.keys(FIELDS).find((k) => FIELDS[k] === e.target.id);
    if (key && e.key === "Enter") {
      e.preventDefault();
      if (e.target.value.trim() !== "") $(LOCKS[key]).checked = true;
      lockStyle(); cv.focus();
      if (S.mouse) pointer(S.mouse[0], S.mouse[1]);
      draw();
    } else if (key && e.key === "Escape") {
      $(LOCKS[key]).checked = false; lockStyle(); cv.focus(); draw();
    }
    return;
  }
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.ctrlKey || e.metaKey) && k === "y") { e.preventDefault(); redo(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (k === " ") { S.space = true; e.preventDefault(); return; }
  if (FIELDS[k]) {
    e.preventDefault();
    if (e.shiftKey && k !== "d") { const id = "r" + k; $(id).checked = !$(id).checked; }
    else { $(FIELDS[k]).focus(); $(FIELDS[k]).select(); }
  } else if (k === "1") setMode("edit");
  else if (k === "2") setMode("Point");
  else if (k === "3") setMode("LineString");
  else if (k === "4") setMode("Polygon");
  else if (k === "5") setMode("nudge");
  else if (k === "[" || k === "]") {
    const el = $("nSize");
    el.value = Math.max(4, Math.min(200, Math.round((+el.value || 30) * (k === "]" ? 1.25 : 0.8))));
  }
  else if (k === "s") $("snapOn").checked = !$("snapOn").checked;
  else if (k === "b") {
    const b = $("bearing");
    if (+b.value) { b.dataset.last = b.value; b.value = "0"; } else b.value = b.dataset.last || "15";
  } else if (k === "p") {
    S.pending = S.pending === "perp" ? "para" : S.pending === "para" ? null : "perp";
    status(S.pending ? `Click a segment to lock the angle ${S.pending === "perp" ? "perpendicular" : "parallel"} to it.` : "");
  } else if (k === "f") fit();
  else if (k === "enter") finishDraft();
  else if (k === "escape") {
    if (S.pending) { S.pending = null; status(""); }
    else if (S.draft.length) S.draft = [];
    else if (anyLocked()) unlockAll();
    else { S.sel = null; panels(); }
  } else if (k === "backspace" && S.draft.length) { e.preventDefault(); S.draft.pop(); }
  else if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSelected(); }
  else return;
  if (S.mouse) pointer(S.mouse[0], S.mouse[1]);
  draw();
});

window.addEventListener("keyup", (e) => { if (e.key === " ") S.space = false; });

function setMode(m) {
  S.mode = m; S.draft = [];
  for (const b of document.querySelectorAll(".modes button")) b.classList.toggle("on", b.dataset.mode === m);
  cv.focus();
  draw();
}

// ---- drawing ------------------------------------------------------------------------------------

function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function pathRing(xy, closed, ring = null) {
  const eo = edgeOpts();
  if (eo.curve && xy.length > 1) {
    // a ring object caches its curves; a preview computes them afresh
    const paths = ring && ring.xy === xy ? segmentPaths(ring, eo) : segmentPaths({ xy, closed }, eo);
    paths.forEach((path, k) => path.forEach((p, i) => {
      const s = toScreen(p);
      if (k === 0 && i === 0) ctx.moveTo(s[0], s[1]); else if (i > 0) ctx.lineTo(s[0], s[1]);
    }));
    if (closed) ctx.closePath();
    return;
  }
  xy.forEach((p, i) => { const s = toScreen(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
  if (closed) ctx.closePath();
}

// The geometry as drawn, with the drag in progress previewed.
function previewRing(fid, ri, r) {
  const d = S.drag;
  if (!d || !S.hit || !d.moved || d.kind === "pan") return r.xy;
  if (d.kind === "mid" && (d.fid !== fid || d.ri !== ri)) return r.xy;
  if (d.kind === "vertex" && !(d.fid === fid && d.ri === ri) && !d.shared.some((s) => s.fid === fid && s.ri === ri)) return r.xy;
  const xy = r.xy.slice();
  if (d.kind === "vertex") xy.forEach((p, i) => { if (isDragged(d, fid, ri, i)) xy[i] = S.hit.pt; });
  else if (d.kind === "mid") xy.splice(d.b === 0 ? xy.length : d.a + 1, 0, S.hit.pt);
  return xy;
}

function draw() {
  const c = { canvas: css("--canvas"), feat: css("--feat"), fill: css("--fill"), accent: css("--accent"),
    edited: css("--edited"), guide: css("--guide"), snap: css("--snap"), grid: css("--grid"), draft: css("--draft"),
    fg: css("--fg"), muted: css("--muted") };
  ctx.fillStyle = c.canvas;
  ctx.fillRect(0, 0, S.w, S.h);
  if (!S.doc) { readout(); return; }
  drawUnderlay();

  // grid
  const g = +$("gridStep").value;
  if ($("sGrid").checked && g > 0 && g / S.view.scale >= 8) {
    const [x0, y1] = toWorld([0, 0]), [x1, y0] = toWorld([S.w, S.h]);
    ctx.fillStyle = c.grid;
    for (let x = Math.ceil(x0 / g) * g; x <= x1; x += g) {
      for (let y = Math.ceil(y0 / g) * g; y <= y1; y += g) {
        const s = toScreen([x, y]);
        ctx.fillRect(s[0] - 1, s[1] - 1, 2, 2);
      }
    }
  }

  // features
  for (const f of S.doc.features) {
    const on = S.sel && S.sel.fid === f.id;
    ctx.lineWidth = on ? 2.5 : 1.5;
    ctx.strokeStyle = on ? c.accent : c.feat;
    if (f.type.endsWith("Polygon")) {
      ctx.beginPath();
      f.rings.forEach((r, ri) => pathRing(previewRing(f.id, ri, r), true, r));
      ctx.fillStyle = c.fill;
      ctx.fill("evenodd");
      ctx.stroke();
    } else if (f.type.endsWith("LineString")) {
      ctx.beginPath();
      f.rings.forEach((r, ri) => pathRing(previewRing(f.id, ri, r), false, r));
      ctx.stroke();
    } else {
      f.rings.forEach((r, ri) => {
        const s = toScreen(previewRing(f.id, ri, r)[0]);
        ctx.beginPath(); ctx.arc(s[0], s[1], on ? 5 : 4, 0, 2 * Math.PI);
        ctx.fillStyle = on ? c.accent : c.feat; ctx.fill();
      });
    }
  }

  // vertices and midpoints of the selected feature
  if (S.sel) {
    const f = featureById(S.doc, S.sel.fid);
    if (f && edgeOpts().curve) {
      // the straight grid chords, faint, against the geodesic edges
      ctx.save();
      ctx.strokeStyle = c.muted; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
      for (const r of f.rings) {
        if (r.xy.length < 2) continue;
        ctx.beginPath();
        r.xy.forEach((p, i) => { const s = toScreen(p); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
        if (r.closed) ctx.closePath();
        ctx.stroke();
      }
      ctx.restore();
    }
    if (f) {
      f.rings.forEach((r, ri) => {
        const xy = previewRing(f.id, ri, r);
        if (S.mode === "edit" && xy.length > 1) {
          ctx.fillStyle = c.muted;
          for (const [a, b] of segments({ xy, closed: r.closed })) {
            const m = toScreen(midOf(xy[a], xy[b]));
            ctx.beginPath(); ctx.arc(m[0], m[1], 2.5, 0, 2 * Math.PI); ctx.fill();
          }
        }
        xy.forEach((p, vi) => {
          const s = toScreen(p);
          const picked = S.sel.ri === ri && S.sel.vi === vi;
          const edited = vi < r.src.length && r.xy[vi] === p && r.src[vi] === null;
          ctx.fillStyle = picked ? c.accent : edited ? c.edited : c.canvas;
          ctx.strokeStyle = picked ? c.accent : edited ? c.edited : c.fg;
          ctx.lineWidth = 1.2;
          if (S.mode === "nudge") { ctx.fillStyle = ctx.strokeStyle; ctx.fillRect(s[0] - 1.5, s[1] - 1.5, 3, 3); return; }
          ctx.fillRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
          ctx.strokeRect(s[0] - 3.5, s[1] - 3.5, 7, 7);
        });
      });
    }
  }

  // the shape being drawn, with its rubber band
  if (S.draft.length) {
    ctx.strokeStyle = c.draft; ctx.lineWidth = 2;
    ctx.beginPath();
    pathRing(S.hit ? [...S.draft, S.hit.pt] : S.draft, S.mode === "Polygon" && S.draft.length >= 2);
    ctx.stroke();
    ctx.fillStyle = c.draft;
    for (const p of S.draft) { const s = toScreen(p); ctx.fillRect(s[0] - 3, s[1] - 3, 6, 6); }
  }

  // guides, the snap and the placed point
  if (S.hit && (drawingMode() || (S.drag && S.drag.kind !== "nudge"))) drawGuides(S.hit.guides, c.guide);
  if (S.hit && S.hit.snap) {
    // a segment snap under a line or circle constraint lands where the two cross
    const sn = S.hit.snap.kind === "segment" && S.hit.guides.length ? { ...S.hit.snap, pt: S.hit.pt } : S.hit.snap;
    drawSnap(sn, c.snap);
  }
  if (S.hit && (drawingMode() || (S.drag && (S.drag.kind === "vertex" || S.drag.kind === "mid")))) {
    const s = toScreen(S.hit.pt);
    ctx.strokeStyle = c.draft; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(s[0] - 6, s[1]); ctx.lineTo(s[0] + 6, s[1]); ctx.moveTo(s[0], s[1] - 6); ctx.lineTo(s[0], s[1] + 6); ctx.stroke();
  }
  if (S.mode === "nudge") drawBrush(c);
  readout();
}

function drawGuides(guides, color) {
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([5, 4]);
  const big = (S.w + S.h) * S.view.scale * 2;
  for (const g of guides) {
    ctx.beginPath();
    if (g.kind === "xline") { const s = toScreen([g.x, 0]); ctx.moveTo(s[0], 0); ctx.lineTo(s[0], S.h); }
    else if (g.kind === "yline") { const s = toScreen([0, g.y]); ctx.moveTo(0, s[1]); ctx.lineTo(S.w, s[1]); }
    else if (g.kind === "ray") {
      const a = toScreen(add(g.o, mul(g.dir, -big))), b = toScreen(add(g.o, mul(g.dir, big)));
      ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]);
    } else if (g.kind === "circle") {
      const s = toScreen(g.c);
      ctx.arc(s[0], s[1], g.r / S.view.scale, 0, 2 * Math.PI);
    }
    ctx.stroke();
  }
  ctx.restore();
}

// Glyphs by kind: vertex a square, segment an hourglass, middle a
// triangle, intersection a cross, grid a plus.
function drawSnap(sn, color) {
  const s = toScreen(sn.pt), r = 7;
  ctx.save();
  ctx.strokeStyle = color; ctx.lineWidth = 2;
  ctx.beginPath();
  if (sn.kind === "vertex") ctx.rect(s[0] - r, s[1] - r, 2 * r, 2 * r);
  else if (sn.kind === "segment") {
    ctx.moveTo(s[0] - r, s[1] - r); ctx.lineTo(s[0] + r, s[1] - r); ctx.lineTo(s[0] - r, s[1] + r);
    ctx.lineTo(s[0] + r, s[1] + r); ctx.closePath();
  } else if (sn.kind === "middle") {
    ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0] + r, s[1] + r * 0.7); ctx.lineTo(s[0] - r, s[1] + r * 0.7); ctx.closePath();
  } else if (sn.kind === "intersection") {
    ctx.moveTo(s[0] - r, s[1] - r); ctx.lineTo(s[0] + r, s[1] + r); ctx.moveTo(s[0] + r, s[1] - r); ctx.lineTo(s[0] - r, s[1] + r);
  } else {
    ctx.moveTo(s[0] - r, s[1]); ctx.lineTo(s[0] + r, s[1]); ctx.moveTo(s[0], s[1] - r); ctx.lineTo(s[0], s[1] + r);
  }
  ctx.stroke();
  ctx.font = "11px system-ui, sans-serif";
  ctx.fillStyle = color;
  ctx.fillText(sn.kind, s[0] + r + 3, s[1] - r);
  ctx.restore();
}

const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : "-");

function readout() {
  if (!S.doc) { $("readout").textContent = "Load data to start."; return; }
  const parts = [];
  const p = S.hit ? S.hit.pt : null;
  parts.push(p ? `x ${fmt(p[0])}  y ${fmt(p[1])}` : "x -  y -");
  parts.push(`snap ${S.hit && S.hit.snap ? S.hit.snap.kind : "-"}`);
  const { ref } = (drawingMode() || S.drag) ? reference() : { ref: null };
  if (ref && p) {
    const th = Math.atan2(p[1] - ref[1], p[0] - ref[0]);
    parts.push(`d ${fmt(dist(ref, p))}  a ${fmt(fromTheta(th, $("conv").value), 4)}`);
    if (S.geo && dist(ref, p) > 0) {
      const a = S.geo.toLL(ref), b = S.geo.toLL(p), g = inverse(a[0], a[1], b[0], b[1]);
      if (g) parts.push(`ground ${fmt(g.s)}  true az ${fmt(g.az1, 4)}`);
    }
  }
  if (S.geo && p) parts.push(`k ${fmt(S.geo.scale(p), 6)}  conv ${fmt(S.geo.convergence(p), 4)}`);
  if (S.pending) parts.push(`pick a segment: ${S.pending === "perp" ? "perpendicular" : "parallel"}`);
  parts.push(`1 px = ${S.view.scale.toPrecision(3)}`);
  $("readout").textContent = parts.join("   ");
}

// ---- panels -----------------------------------------------------------------------------------------

function panels() {
  const info = $("info"), box = $("coords");
  const f = S.sel && featureById(S.doc, S.sel.fid);
  if (!f) {
    info.textContent = "Nothing selected.";
    box.hidden = true;
  } else {
    const nv = f.rings.reduce((s, r) => s + r.xy.length, 0);
    const ne = f.rings.reduce((s, r) => s + r.src.filter((x) => x === null).length, 0);
    let m = "";
    if (f.type.endsWith("Polygon")) m = `area ${fmt(Math.abs(f.rings.reduce((s, r, i) => s + (i && r.part === f.rings[i - 1].part ? -Math.abs(ringArea(r.xy)) : Math.abs(ringArea(r.xy))), 0)), 2)}`;
    else if (f.type.endsWith("LineString")) m = `length ${fmt(f.rings.reduce((s, r) => s + ringLength(r), 0), 3)}`;
    const props = Object.entries(f.props || {}).map(([k, v]) => `${k}: ${v}`).join(", ");
    info.textContent = `${f.id} (${f.type}), ${nv} vertices, ${ne} edited${m ? ", " + m : ""}${props ? "\n" + props : ""}`;
    coordTable(f);
    box.hidden = false;
  }
  const n = S.hist ? S.hist.done.length : 0;
  $("log").textContent = n ? S.hist.log().split("\n").slice(-12).join("\n") : "No edits yet.";
  $("log").scrollTop = 1e9;
  $("undo").disabled = !n;
  $("redo").disabled = !(S.hist && S.hist.undone.length);
}

// The coordinate list: one row per vertex, editable. A typed value is a
// move like any other, so it lands in the log and undoes.
function coordTable(f) {
  const box = $("coords");
  const multi = f.rings.length > 1;
  let html = `<table><thead><tr>${multi ? "<th>ring</th>" : ""}<th>#</th><th>x</th><th>y</th><th></th></tr></thead><tbody>`;
  f.rings.forEach((r, ri) => r.xy.forEach((p, vi) => {
    const on = S.sel.ri === ri && S.sel.vi === vi;
    const ed = r.src[vi] === null;
    html += `<tr data-ri="${ri}" data-vi="${vi}" class="${on ? "on" : ""}">${multi ? `<td>${ri}</td>` : ""}<td>${vi}</td>` +
      `<td><input data-k="0" value="${fmt(p[0])}" title="${p[0]}"></td><td><input data-k="1" value="${fmt(p[1])}" title="${p[1]}"></td>` +
      `<td class="${ed ? "ed" : ""}" title="${ed ? "edited: written back through the frame" : "as read: written back unchanged"}">${ed ? "edited" : ""}</td></tr>`;
  }));
  box.innerHTML = html + "</tbody></table>";
  const sel = box.querySelector("tr.on");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

$("coords").addEventListener("focusin", (e) => {
  const tr = e.target.closest("tr[data-vi]");
  if (!tr || !S.sel) return;
  S.sel = { fid: S.sel.fid, ri: +tr.dataset.ri, vi: +tr.dataset.vi };
  for (const r of $("coords").querySelectorAll("tr")) r.classList.toggle("on", r === tr);
  e.target.value = e.target.title; // full precision while editing
  draw();
});

$("coords").addEventListener("change", (e) => {
  const tr = e.target.closest("tr[data-vi]");
  if (!tr || !S.sel) return;
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) { panels(); return; }
  const ri = +tr.dataset.ri, vi = +tr.dataset.vi;
  const r = featureById(S.doc, S.sel.fid).rings[ri];
  const to = r.xy[vi].slice();
  to[+e.target.dataset.k] = v;
  S.hist.run({ op: "move", fid: S.sel.fid, ri, vi, to });
  S.sel = { fid: S.sel.fid, ri, vi };
  panels(); draw();
});

$("coords").addEventListener("keydown", (e) => { if (e.key === "Enter") e.target.blur(); });

// ---- wiring --------------------------------------------------------------------------------------------

$("sample").onclick = () => setDoc(sampleParcels(), "sample parcels (synthetic)", "EPSG:32755");
$("applyFrame").onclick = () => applyFrame();
$("utm").onclick = utmZone;
for (const id of ["srcCrs", "editCrs"]) $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") applyFrame(); });
$("loadCog").onclick = () => loadCog($("cogUrl").value.trim());
$("cogUrl").addEventListener("keydown", (e) => { if (e.key === "Enter") $("loadCog").click(); });
$("opacity").oninput = () => draw();
for (const id of ["measure", "north", "edges"]) $(id).onchange = () => { touchAll(); draw(); };
$("file").onchange = (e) => e.target.files[0] && loadFile(e.target.files[0]);
$("load").onclick = () => $("url").value && loadUrl($("url").value.trim());
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("load").click(); });
$("undo").onclick = undo;
$("redo").onclick = redo;
$("fit").onclick = fit;
$("perp").onclick = () => { S.pending = "perp"; status("Click a segment to lock the angle perpendicular to it."); cv.focus(); };
$("para").onclick = () => { S.pending = "para"; status("Click a segment to lock the angle parallel to it."); cv.focus(); };
$("unlock").onclick = () => { unlockAll(); draw(); };
for (const b of document.querySelectorAll(".modes button")) b.onclick = () => setMode(b.dataset.mode);
for (const id of Object.values(LOCKS)) $(id).onchange = () => { lockStyle(); draw(); };
$("saveGeo").onclick = () => S.doc && download("edited.geojson", JSON.stringify(toGeoJSON(S.doc)), "application/geo+json");
$("saveLog").onclick = () => S.hist && download("edits.jsonl", S.hist.log() + "\n", "application/x-ndjson");

new ResizeObserver(resize).observe($("wrap"));
setMode("edit");
const q = new URLSearchParams(location.search).get("url");
if (q) { $("url").value = q; loadUrl(q); } else setDoc(sampleParcels(), "sample parcels (synthetic)", "EPSG:32755");

// for tests and the console
window.wxyEdit = { S, toScreen, toWorld, toGeoJSON: () => toGeoJSON(S.doc), wasmReady, applyFrame };
