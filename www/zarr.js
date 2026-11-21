// The view plan page: for the view on the canvas, which chunks of which
// level a source is asked for (rwarp::view in wasm), drawn over the map
// and counted beside the one-box rule. A COG source is then fetched and
// drawn by its plan; a Zarr source is planned from its metadata.
import init, { Cog, Transform, planView } from "./pkg/wxy_web.js";
import { openZarr, flatLevels } from "./zarrmeta.js";

const FIXTURES = "https://raw.githubusercontent.com/wxylib/fixtures/main/";
const GHRSST = "https://data.source.coop/ausantarctic/ghrsst-mur-v2/2024/01/15/" +
  "20240115090000-JPL-L4_GHRSST-SSTfnd-MUR-GLOB-v02.0-fv04.1_analysed_sst.tif";
const HERE = new URL("./data/zarr/", import.meta.url).href;
const SOURCES = [
  { name: "A global 0.01 degree pyramid (Zarr metadata, 7 levels)", url: HERE + "mur-pyramid.zarr", view: "south" },
  { name: "The same grid with no overviews (Zarr metadata, 1 array)",
    url: HERE + "mur-full-resolution.zarr/analysed_sst", view: "seam" },
  { name: "GHRSST MUR sea surface temperature, one day (COG, source.coop)", url: GHRSST, view: "south" },
  { name: "World, 0.5 degree (COG, wxylib/fixtures)", url: FIXTURES + "cog/world-int16-deflate.tif", view: "globe" },
  { name: "Antarctic, 12 km, polar stereographic (COG, wxylib/fixtures)",
    url: FIXTURES + "cog/polar-f32-zstd-bigtiff.tif", view: "globe" },
  { name: "World, 0.5 degree (Zarr metadata, wxylib/fixtures)", url: FIXTURES + "zarr/world-int16-spatial.zarr/data", view: "globe" },
  { name: "Your own COG or Zarr URL", url: "", view: "globe" },
];

const R = 6371000;
// half-widths are in the view CRS's units; the height follows the canvas
const VIEWS = {
  globe: { name: "Globe (orthographic)", globe: [147, -42], half: 6.6e6 * 4 / 3 },
  south: { name: "South polar stereographic (EPSG:3031)", crs: "EPSG:3031", centre: [0, 0], half: 4e6 * 4 / 3 },
  north: { name: "North polar stereographic (EPSG:3413)", crs: "EPSG:3413", centre: [0, 0], half: 4e6 * 4 / 3 },
  seam: { name: "Longitude / latitude across 180", crs: "EPSG:4326", centre: [180, -10], half: 20 },
  world: { name: "Longitude / latitude, whole world", crs: "EPSG:4326", centre: [0, 0], half: 180 },
  merc: { name: "Web Mercator (EPSG:3857)", crs: "EPSG:3857", centre: [0, 0], half: 2.0037508e7 },
};
// fine levels warm, coarse levels cool
const LEVEL_COLOURS = ["#b2182b", "#e8601c", "#f1932d", "#d9a300", "#7fb800", "#2e9e5b", "#1f8fb0", "#3b6fd6",
                       "#6a51a3", "#9e6ebd"];
const VIRIDIS = [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]];

const $ = (id) => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");
const W = canvas.width, H = canvas.height;
const data = document.createElement("canvas");
data.width = W; data.height = H;
const dctx = data.getContext("2d");

let source = null;      // { kind, url, crs, levels, flat, cog, bytesPerCell, geographic, note }
let view = null;        // { key, crs, extent: [xmin, xmax, ymin, ymax], lon0, lat0 }
let toView = null;      // Transform: source CRS to view CRS (and back)
let lonlat = null;      // Transform: EPSG:4326 to view CRS, for the graticule
let plan = null, single = null, planMs = 0;
let settled = new Set();          // the keys of the plan before this gesture
let seq = 0, dataFor = null, fetched = null;

function say(text, error = false) {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
}

const isGeographic = (crs) => /^EPSG:4326$|longlat|latlong|lonlat/i.test(crs || "");

// ---------------------------------------------------------------- sources

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}

async function openSource(url) {
  url = url.trim();
  if (!url) { say("Paste the URL of a COG, or of a Zarr v3 array or multiscales group, served with CORS."); return false; }
  say("Opening " + url + " ...");
  try {
    if (/\.tiff?($|\?)/i.test(url)) {
      const cog = await Cog.open(url);
      const flat = Float64Array.from(cog.levels());
      const levels = [];
      for (let i = 0; i < flat.length; i += 10) {
        levels.push({ gt: [...flat.slice(i, i + 6)], size: [flat[i + 6], flat[i + 7]], chunk: [flat[i + 8], flat[i + 9]] });
      }
      const info = JSON.parse(cog.info());
      source = { kind: "cog", url, cog, crs: cog.sourceCrs(), levels, flat, bytesPerCell: null,
                 note: `COG, ${info.dtype}, ${levels.length} levels` };
    } else {
      const z = await openZarr(url, getJson);
      source = { kind: "zarr", url, cog: null, crs: z.crs, levels: z.levels, flat: flatLevels(z.levels),
                 bytesPerCell: z.bytesPerCell, note: `Zarr ${z.dtype}, ${z.kind}` };
    }
  } catch (e) {
    source = null;
    say(String(e.message || e), true);
    return false;
  }
  source.geographic = isGeographic(source.crs);
  settled = new Set();
  dataFor = null; fetched = null;
  legend();
  return true;
}

function legend() {
  const cell = (l) => Math.sqrt(Math.abs(l.gt[1] * l.gt[5] - l.gt[2] * l.gt[4]));
  const unit = source.geographic ? " deg" : " m";
  $("legend").innerHTML = source.levels.map((l, k) =>
    `<span><span class="sw" style="background:${LEVEL_COLOURS[k % LEVEL_COLOURS.length]}"></span>` +
    `level ${k}: ${+cell(l).toPrecision(3)}${unit}, ${l.size[0]} x ${l.size[1]}</span>`).join("");
}

// ------------------------------------------------------------------ views

function orthoCrs(lon0, lat0) {
  return `+proj=ortho +lon_0=${lon0.toFixed(4)} +lat_0=${lat0.toFixed(4)} +R=${R}`;
}

function setView(key) {
  const v = VIEWS[key];
  const hw = v.half, hh = hw * H / W;
  if (v.globe) {
    view = { key, lon0: v.globe[0], lat0: v.globe[1], crs: orthoCrs(...v.globe), extent: [-hw, hw, -hh, hh] };
  } else {
    view = { key, crs: v.crs, extent: [v.centre[0] - hw, v.centre[0] + hw, v.centre[1] - hh, v.centre[1] + hh] };
  }
  bindView();
}

// Transforms for the current view CRS. False when proj4rs has no such pair.
function bindView() {
  try {
    toView = new Transform(source.crs, view.crs);
    lonlat = new Transform("EPSG:4326", view.crs);
    return true;
  } catch (e) {
    toView = lonlat = null;
    say(String(e.message || e), true);
    return false;
  }
}

const toScreen = (x, y) => [(x - view.extent[0]) / (view.extent[1] - view.extent[0]) * W,
                            (view.extent[3] - y) / (view.extent[3] - view.extent[2]) * H];

// --------------------------------------------------------------- planning

function makePlan(singleBox) {
  const tile = +$("tile").value, quality = +$("quality").value, budget = +$("budget").value;
  return source.cog
    ? source.cog.planView(view.crs, view.extent, W, H, tile, quality, budget, singleBox)
    : planView(view.crs, view.extent, W, H, source.crs, source.flat, tile, quality, budget, singleBox);
}

const keyOf = (c, i) => `${c[i]}/${c[i + 1]}/${c[i + 2]}`;
function keySet(p) {
  const s = new Set();
  for (let i = 0; i < p.chunks.length; i += 3) s.add(keyOf(p.chunks, i));
  return s;
}

function sizeOf(p) {
  if (p.bytes) return [p.bytes.reduce((a, b) => a + b, 0), "stored"];
  if (source.bytesPerCell) return [p.cells * source.bytesPerCell, "uncompressed"];
  return [null, ""];
}

function levelsOf(p) {
  const s = new Set();
  for (let i = 0; i < p.chunks.length; i += 3) s.add(p.chunks[i]);
  return [...s].sort((a, b) => a - b);
}

const mb = (b) => b === null ? "" : b >= 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(b < 1e7 ? 2 : 1) + " MB";
const cellsText = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + " M cells" : Math.round(n) + " cells";

function replan() {
  if (!source || !toView) return false;
  try {
    const t0 = performance.now();
    plan = makePlan(false);
    planMs = performance.now() - t0;
    single = makePlan(true);
  } catch (e) {
    plan = single = null;
    say(String(e.message || e), true);
    return false;
  }
  const [pb, kind] = sizeOf(plan), [sb] = sizeOf(single);
  $("sizeHead").textContent = kind ? `Size (${kind})` : "Size";
  $("pChunks").textContent = plan.chunks.length / 3;
  $("sChunks").textContent = single.chunks.length / 3;
  $("pSize").textContent = pb === null ? cellsText(plan.cells) : mb(pb);
  $("sSize").textContent = sb === null ? cellsText(single.cells) : mb(sb);
  $("pLevels").textContent = levelsOf(plan).join(", ");
  $("sLevels").textContent = levelsOf(single).join(", ");
  return true;
}

function report() {
  if (!plan) return;
  const now = keySet(plan);
  let keep = 0;
  for (const k of now) if (settled.has(k)) keep++;
  const pc = plan.cells, sc = single.cells;
  const parts = [`${source.note} in ${source.crs}. Planned in ${planMs.toFixed(1)} ms` +
    (plan.overBudget ? ", over budget at the coarsest level" : "") + "."];
  if (sc > 0 && pc > 0) {
    parts.push(pc < sc * 0.995 ? `The plan reads ${(sc / pc).toFixed(1)} times fewer cells than one box.`
                               : "Here one box does as well: the view is small or the scale is even.");
  }
  if (settled.size) parts.push(`From the last view: fetch ${now.size - keep}, keep ${keep}, drop ${settled.size - keep}.`);
  if (fetched && dataFor === view.crs + view.extent.join()) {
    parts.push(`Fetched: ${fetched.requests} range requests, ${mb(fetched.bytes)}, drawn in ${fetched.ms.toFixed(0)} ms.`);
  }
  say(parts.join(" "));
}

// ---------------------------------------------------------------- drawing

// Polylines through `to`: [x, y, x, y, ...] in the transform's source CRS,
// drawn where the points map and come back to where they started (so the
// far side of a globe is left out). `wrap` draws copies 360 apart.
function strokePath(t, xy, wrap, periodic) {
  const f = t.forward(xy), b = t.inverse(f);
  const shifts = wrap ? [-360, 0, 360] : [0];
  for (const s of shifts) {
    ctx.beginPath();
    let pen = false, px = 0, py = 0;
    for (let i = 0; i < xy.length; i += 2) {
      let dx = b[i] - xy[i];
      if (periodic) dx -= 360 * Math.round(dx / 360);
      const tol = 1e-6 * (Math.abs(xy[i]) + Math.abs(xy[i + 1]) + 1);
      const ok = Number.isFinite(f[i]) && Math.abs(dx) < tol && Math.abs(b[i + 1] - xy[i + 1]) < tol;
      if (!ok) { pen = false; continue; }
      const [sx, sy] = toScreen(f[i] + s, f[i + 1]);
      if (pen && Math.abs(sx - px) < W / 2 && Math.abs(sy - py) < H / 2) ctx.lineTo(sx, sy);
      else ctx.moveTo(sx, sy);
      pen = true; px = sx; py = sy;
    }
    ctx.stroke();
  }
}

function graticule() {
  if (!lonlat) return;
  const css = getComputedStyle(document.documentElement);
  ctx.strokeStyle = css.getPropertyValue("--line");
  ctx.lineWidth = 1;
  const wrap = isGeographic(view.crs);
  for (let lon = -180; lon < 180; lon += 30) {
    const xy = [];
    for (let lat = -90; lat <= 90; lat += 2) xy.push(lon, lat);
    strokePath(lonlat, xy, wrap, true);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const xy = [];
    for (let lon = -180; lon <= 180; lon += 2) xy.push(lon, lat);
    strokePath(lonlat, xy, wrap, true);
  }
}

// The outline of a chunk in the source CRS, 12 points a side.
function chunkOutline(level, col, row) {
  const l = source.levels[level], g = l.gt;
  const c0 = col * l.chunk[0], c1 = Math.min(c0 + l.chunk[0], l.size[0]);
  const r0 = row * l.chunk[1], r1 = Math.min(r0 + l.chunk[1], l.size[1]);
  const corners = [[c0, r0], [c1, r0], [c1, r1], [c0, r1], [c0, r0]], xy = [], N = 12;
  for (let k = 0; k < 4; k++) {
    for (let i = 0; i < N; i++) {
      const c = corners[k][0] + (corners[k + 1][0] - corners[k][0]) * i / N;
      const r = corners[k][1] + (corners[k + 1][1] - corners[k][1]) * i / N;
      xy.push(g[0] + c * g[1] + r * g[2], g[3] + c * g[4] + r * g[5]);
    }
  }
  xy.push(xy[0], xy[1]);
  return xy;
}

function drawChunks(p, colour, dash) {
  const wrap = isGeographic(view.crs) && source.geographic;
  ctx.setLineDash(dash);
  ctx.lineWidth = 1.5;
  for (let i = 0; i < p.chunks.length; i += 3) {
    const level = p.chunks[i];
    ctx.strokeStyle = colour || LEVEL_COLOURS[level % LEVEL_COLOURS.length];
    strokePath(toView, chunkOutline(level, p.chunks[i + 1], p.chunks[i + 2]), wrap, source.geographic);
  }
  ctx.setLineDash([]);
}

function drawTiles() {
  const tile = +$("tile").value, t = plan.tiles;
  ctx.font = "10px system-ui, sans-serif";
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  for (let i = 0; i < t.length; i += 7) {
    const x = t[i] * tile, y = t[i + 1] * tile, planned = t[i + 3], visible = t[i + 5];
    ctx.globalAlpha = (dataFor ? 0.16 : 0.34) * Math.max(0.25, visible);
    ctx.fillStyle = LEVEL_COLOURS[planned % LEVEL_COLOURS.length];
    ctx.fillRect(x, y, tile, tile);
    ctx.globalAlpha = 1;
    if (tile >= 64) {
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
      ctx.globalAlpha = 0.55;
      // a level the budget made coarser than the tile needs is marked
      ctx.fillText(planned === t[i + 2] ? String(planned) : `${planned}*`, x + tile / 2, y + tile / 2);
      ctx.globalAlpha = 1;
    }
    if (t[i + 6]) {
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--fg");
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 2, y + 2, tile - 4, tile - 4);
    }
  }
}

function redraw() {
  ctx.clearRect(0, 0, W, H);
  if (!source || !view) return;
  if (dataFor === view.crs + view.extent.join()) ctx.drawImage(data, 0, 0);
  graticule();
  if (!plan) return;
  if ($("showTiles").checked) drawTiles();
  if ($("showSingle").checked) drawChunks(single, "#d70015", [5, 4]);
  if ($("showChunks").checked) drawChunks(plan, null, []);
}

// ---------------------------------------------- fetch and draw, by the plan

function ramp(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < VIRIDIS.length; i++) {
    if (t <= VIRIDIS[i][0]) {
      const [s0, ...a] = VIRIDIS[i - 1], [s1, ...b] = VIRIDIS[i];
      const f = (t - s0) / (s1 - s0 || 1);
      return a.map((v, k) => v + f * (b[k] - v));
    }
  }
  return VIRIDIS[VIRIDIS.length - 1].slice(1);
}

function paint(done, lo, hi) {
  for (const d of done) {
    const n = d.w * d.h, img = dctx.createImageData(d.w, d.h), px = img.data, v = d.out.values;
    const rgb = d.out.bands >= 3;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(v[i])) continue;
      const s = (x) => 255 * (x - lo) / (hi - lo || 1);
      const c = rgb ? [s(v[i]), s(v[n + i]), s(v[2 * n + i])] : ramp((v[i] - lo) / (hi - lo || 1));
      px[4 * i] = c[0]; px[4 * i + 1] = c[1]; px[4 * i + 2] = c[2]; px[4 * i + 3] = 255;
    }
    dctx.putImageData(img, d.x, d.y);
  }
}

function stretch(done) {
  const v = [];
  for (const d of done) {
    const vals = d.out.values, step = Math.max(1, Math.floor(vals.length / 400));
    for (let i = 0; i < vals.length; i += step) if (Number.isFinite(vals[i])) v.push(vals[i]);
  }
  if (!v.length) return [0, 1];
  v.sort((a, b) => a - b);
  return [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]];
}

// Fetch the plan's chunks in one batch, then warp each screen tile from
// the level the plan gave it, nearest the centre first. A newer view
// (a larger `seq`) abandons this one.
async function drawData() {
  if (!source?.cog || !plan || !$("showData").checked) return;
  const mine = ++seq, crs = view.crs, e = view.extent.slice();
  const tile = +$("tile").value, t = plan.tiles;
  const before = fetched?.total ?? { requests: 0, bytes: 0 };
  const t0 = performance.now();
  try {
    const stats = await source.cog.prefetch(plan.chunks);
    if (mine !== seq) return;
    const tiles = [];
    for (let i = 0; i < t.length; i += 7) {
      const x = t[i] * tile, y = t[i + 1] * tile;
      tiles.push({ x, y, w: Math.min(tile, W - x), h: Math.min(tile, H - y), level: t[i + 3],
                   d: Math.hypot(x + tile / 2 - W / 2, y + tile / 2 - H / 2) });
    }
    tiles.sort((a, b) => a.d - b.d);
    dctx.clearRect(0, 0, W, H);
    dataFor = crs + e.join();
    const sx = (e[1] - e[0]) / W, sy = (e[3] - e[2]) / H, done = [];
    let range = null, last = stats;
    for (const d of tiles) {
      const ext = [e[0] + d.x * sx, e[0] + (d.x + d.w) * sx, e[3] - (d.y + d.h) * sy, e[3] - d.y * sy];
      d.out = await source.cog.warpLevel(crs, ext, d.w, d.h, "bilinear", d.level);
      if (mine !== seq) return;
      last = d.out;
      done.push(d);
      if (!range && done.length >= Math.min(8, tiles.length)) range = stretch(done);
      if (range) { paint(done.length === 8 ? done : [d], ...range); redraw(); }
    }
    // the whole view's range, now that every tile is in
    paint(done, ...stretch(done));
    fetched = { requests: last.requests - before.requests, bytes: last.bytes - before.bytes,
                ms: performance.now() - t0, total: { requests: last.requests, bytes: last.bytes } };
    redraw();
    report();
  } catch (err) {
    if (mine === seq) say(String(err.message || err), true);
  }
}

// ------------------------------------------------------------ interaction

// A view change: plan and draw at once; fetch when the gesture ends.
let settleTimer = null;
function changed(now = false) {
  seq++;
  if (!replan()) { redraw(); return; }
  redraw();
  report();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(async () => {
    await drawData();
    settled = keySet(plan);
  }, now ? 0 : 250);
}

async function load(url, viewKey) {
  if (!await openSource(url)) { plan = single = null; redraw(); return; }
  $("view").value = viewKey;
  setView(viewKey);
  if (toView) changed(true);
}

for (const s of SOURCES) $("source").add(new Option(s.name));
for (const [k, v] of Object.entries(VIEWS)) $("view").add(new Option(v.name, k));
$("source").onchange = () => {
  const s = SOURCES[$("source").selectedIndex];
  $("url").value = s.url;
  if (s.url) load(s.url, s.view); else { $("url").focus(); say("Paste the URL of a COG, or of a Zarr v3 array or multiscales group, served with CORS."); }
};
$("go").onclick = () => load($("url").value, $("view").value);
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") $("go").onclick(); });
$("view").onchange = () => { if (!source) return; setView($("view").value); if (toView) changed(true); };
for (const id of ["tile", "quality", "budget"]) $(id).onchange = () => changed(true);
for (const id of ["showTiles", "showChunks", "showSingle"]) $(id).onchange = redraw;
$("showData").onchange = () => { if ($("showData").checked) changed(true); else { dataFor = null; redraw(); } };

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || !view) return;
  const k = (view.extent[1] - view.extent[0]) / canvas.getBoundingClientRect().width;
  const dx = (e.clientX - drag.x) * k, dy = (e.clientY - drag.y) * k;
  drag = { x: e.clientX, y: e.clientY };
  if (view.key === "globe") {
    // turn the globe: metres on the screen to degrees at its centre
    const deg = 180 / (Math.PI * R);
    view.lon0 = ((view.lon0 - dx * deg / Math.max(0.2, Math.cos(view.lat0 * Math.PI / 180)) + 540) % 360) - 180;
    view.lat0 = Math.max(-90, Math.min(90, view.lat0 - dy * deg));
    view.crs = orthoCrs(view.lon0, view.lat0);
    if (!bindView()) return;
  } else {
    view.extent = [view.extent[0] - dx, view.extent[1] - dx, view.extent[2] + dy, view.extent[3] + dy];
  }
  changed();
});
const endDrag = () => { drag = null; canvas.classList.remove("dragging"); };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener("wheel", (e) => {
  if (!view) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect(), x = view.extent;
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const cx = x[0] + fx * (x[1] - x[0]), cy = x[3] - fy * (x[3] - x[2]);
  const k = Math.exp(e.deltaY * 0.0015);
  view.extent = [cx - fx * (x[1] - x[0]) * k, cx + (1 - fx) * (x[1] - x[0]) * k,
                 cy - (1 - fy) * (x[3] - x[2]) * k, cy + fy * (x[3] - x[2]) * k];
  changed();
}, { passive: false });

// Start: ?url=...&view=... override the first source.
await init();
const q = new URLSearchParams(location.search);
const first = q.get("url") ? { url: q.get("url"), view: q.get("view") || "globe" } : SOURCES[0];
if (q.get("url")) $("source").selectedIndex = SOURCES.length - 1;
$("url").value = first.url;
await load(first.url, VIEWS[q.get("view")] ? q.get("view") : first.view);

// for tests and the console
window.viewPlan = { get plan() { return plan; }, get single() { return single; }, get view() { return view; },
                    get source() { return source; }, get fetched() { return fetched; } };
