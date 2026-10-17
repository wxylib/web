// wxylib warp demo: the canvas is a target grid, re-warped on every view.
import init, { Cog } from "./pkg/wxy_web.js";

const FIXTURES = "https://raw.githubusercontent.com/wxylib/fixtures/main/cog/";
const SOURCES = [
  { name: "World, 0.5 degree, synthetic int16 (wxylib/fixtures)",
    url: FIXTURES + "world-int16-deflate.tif", proj: "south" },
  { name: "Antarctic, 12 km, synthetic float32 zstd (wxylib/fixtures)",
    url: FIXTURES + "polar-f32-zstd-bigtiff.tif", proj: "south147" },
  { name: "Sentinel-2 true colour, Hobart, 2024-02-03",
    url: "https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/55/G/EN/2024/2/S2B_55GEN_20240203_0_L2A/TCI.tif",
    proj: "laea" },
  { name: "Your own COG URL", url: "", proj: "native" },
];

// extents are [xmin, xmax, ymin, ymax]; null means fit to the source
const PROJS = {
  south: { name: "South polar stereographic (EPSG:3031)", crs: "EPSG:3031", extent: [-7e6, 7e6, -7e6, 7e6] },
  north: { name: "North polar stereographic (EPSG:3413)", crs: "EPSG:3413", extent: [-7e6, 7e6, -7e6, 7e6] },
  geos: { name: "Geostationary view over 140E", crs: "+proj=geos +h=35785831 +lon_0=140 +datum=WGS84",
          extent: [-5.5e6, 5.5e6, -5.5e6, 5.5e6] },
  moll: { name: "Mollweide", crs: "+proj=moll +datum=WGS84", extent: [-1.81e7, 1.81e7, -9.1e6, 9.1e6] },
  south147: { name: "South polar stereographic, 147E up", crs: "+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=147 +datum=WGS84", extent: null },
  laea: { name: "Lambert azimuthal, Hobart", crs: "+proj=laea +lat_0=-42.9 +lon_0=147.3 +datum=WGS84", extent: null },
  merc: { name: "Web Mercator (EPSG:3857)", crs: "EPSG:3857", extent: [-2.0037508e7, 2.0037508e7, -1.6e7, 1.6e7] },
  longlat: { name: "Longitude / latitude (EPSG:4326)", crs: "EPSG:4326", extent: [-180, 180, -90, 90] },
  native: { name: "The source's own CRS", crs: null, extent: null },
};

const $ = (id) => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");
const status = $("status");

let cog = null, info = null, crs = null, extent = null, stretch = null;
let busy = false, pending = null;

function say(text, error = false) {
  status.textContent = text;
  status.className = error ? "error" : "";
}

// Grow an extent so its aspect matches the canvas.
function fitAspect([x0, x1, y0, y1]) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let w = x1 - x0, h = y1 - y0;
  const a = canvas.width / canvas.height;
  if (w / h > a) h = w / a; else w = h * a;
  return [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
}

// Colour ramps, as [stop, r, g, b] with stops in 0..1.
const VIRIDIS = [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]];
const SEA = [[0, 8, 29, 88], [0.6, 37, 116, 169], [1, 199, 233, 180]];
const LAND = [[0, 26, 152, 80], [0.35, 166, 217, 106], [0.7, 254, 224, 139], [0.9, 158, 112, 74], [1, 250, 250, 250]];

function ramp(stops, t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [s0, ...a] = stops[i - 1], [s1, ...b] = stops[i];
      const f = (t - s0) / (s1 - s0 || 1);
      return a.map((v, k) => v + f * (b[k] - v));
    }
  }
  return stops[stops.length - 1].slice(1);
}

// Value range from the first view of a source: 2nd and 98th percentiles.
function percentiles(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return [0, 1];
  v.sort((a, b) => a - b);
  return [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]];
}

function draw(out, w, h) {
  const n = w * h, img = ctx.createImageData(w, h), px = img.data, vals = out.values;
  if (!stretch) stretch = percentiles(out.bands >= 3 ? vals.subarray(0, 3 * n) : vals.subarray(0, n));
  const [lo, hi] = stretch;
  const rgb = out.bands >= 3;
  const elevation = !rgb && lo < 0 && hi > 0;
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    if (!Number.isFinite(v)) continue; // transparent
    let c;
    if (rgb) {
      const s = (x) => 255 * (x - lo) / (hi - lo || 1);
      c = [s(v), s(vals[n + i]), s(vals[2 * n + i])];
    } else if (elevation) {
      c = v < 0 ? ramp(SEA, 1 - v / lo) : ramp(LAND, v / hi);
    } else {
      c = ramp(VIRIDIS, (v - lo) / (hi - lo || 1));
    }
    px[4 * i] = c[0]; px[4 * i + 1] = c[1]; px[4 * i + 2] = c[2]; px[4 * i + 3] = 255;
  }
  // a quick (half-size) render is drawn scaled up
  if (w === canvas.width) {
    ctx.putImageData(img, 0, 0);
  } else {
    createImageBitmap(img).then((bmp) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    });
  }
}

// Warp the current view; `quick` renders at half size with nearest
// neighbour while dragging. Requests made while busy collapse into one.
async function render(quick = false) {
  if (!cog) return;
  if (busy) { pending = quick; return; }
  busy = true;
  const f = quick ? 2 : 1;
  const w = Math.round(canvas.width / f), h = Math.round(canvas.height / f);
  const alg = quick ? "near" : $("resampling").value;
  try {
    const t0 = performance.now();
    const out = await cog.warp(crs, extent, w, h, alg);
    const ms = performance.now() - t0;
    draw(out, w, h);
    const level = out.level === 0 ? "full resolution" : `overview ${out.level} of ${info.overviews.length}`;
    say(`${w} x ${h} cells in ${crs}, ${alg}, read ${level}, ${ms.toFixed(0)} ms. ` +
        `Range requests so far: ${out.requests}, ${(out.bytes / 1e6).toFixed(2)} MB.`);
  } catch (e) {
    say(String(e.message || e), true);
  }
  busy = false;
  if (pending !== null) { const q = pending; pending = null; render(q); }
}

function setView(projKey) {
  const p = PROJS[projKey];
  crs = p.crs ?? info.crs ?? "EPSG:4326";
  $("crs").value = crs;
  // a preset extent, unless the source is a small part of it
  let b = null;
  try { b = cog.bounds(crs); } catch (e) { if (!p.extent) throw e; }
  const area = (e) => (e[1] - e[0]) * (e[3] - e[2]);
  extent = fitAspect(p.extent && !(b && area(b) < area(p.extent) / 100) ? p.extent : b);
}

async function openSource() {
  const url = $("url").value.trim();
  if (!url) { say("Paste a COG URL (served with CORS) and press Warp."); return; }
  say("Opening " + url + " ...");
  try {
    cog = await Cog.open(url);
  } catch (e) {
    cog = null;
    say(String(e.message || e), true);
    return;
  }
  info = JSON.parse(cog.info());
  stretch = null;
  const src = SOURCES[$("source").selectedIndex];
  const key = src.url === url ? src.proj : $("proj").value;
  $("proj").value = key;
  try { setView(key); } catch (e) { say(String(e.message || e), true); return; }
  render();
}

// Controls
for (const s of SOURCES) $("source").add(new Option(s.name));
for (const [k, p] of Object.entries(PROJS)) $("proj").add(new Option(p.name, k));
$("source").onchange = () => {
  const s = SOURCES[$("source").selectedIndex];
  $("url").value = s.url;
  if (s.url) openSource(); else { $("url").focus(); say("Paste a COG URL (served with CORS) and press Warp."); }
};
$("proj").onchange = () => {
  if (!cog) return;
  try { setView($("proj").value); render(); } catch (e) { say(String(e.message || e), true); }
};
$("resampling").onchange = () => render();
$("go").onclick = openSource;
$("crs").onchange = () => {
  if (!cog) return;
  crs = $("crs").value.trim();
  try { extent = fitAspect(cog.bounds(crs)); render(); } catch (e) { say(String(e.message || e), true); }
};
$("fit").onclick = () => {
  if (!cog) return;
  try { extent = fitAspect(cog.bounds(crs)); render(); } catch (e) { say(String(e.message || e), true); }
};

// Pan and zoom: change the target grid, warp again.
let drag = null;
const scale = () => (extent[1] - extent[0]) / canvas.getBoundingClientRect().width;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag || !extent) return;
  const s = scale(), dx = (e.clientX - drag.x) * s, dy = (e.clientY - drag.y) * s;
  drag = { x: e.clientX, y: e.clientY };
  extent = [extent[0] - dx, extent[1] - dx, extent[2] + dy, extent[3] + dy];
  render(true);
});
const endDrag = () => { if (drag) { drag = null; canvas.classList.remove("dragging"); render(); } };
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
let wheelTimer = null;
canvas.addEventListener("wheel", (e) => {
  if (!extent) return;
  e.preventDefault();
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  const x = extent[0] + fx * (extent[1] - extent[0]);
  const y = extent[3] - fy * (extent[3] - extent[2]);
  const k = Math.exp(e.deltaY * 0.0015);
  extent = [x - fx * (extent[1] - extent[0]) * k, x + (1 - fx) * (extent[1] - extent[0]) * k,
            y - (1 - fy) * (extent[3] - extent[2]) * k, y + fy * (extent[3] - extent[2]) * k];
  render(true);
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => render(), 200);
}, { passive: false });

// Start: ?url=...&crs=... override the first source.
await init();
const q = new URLSearchParams(location.search);
$("url").value = q.get("url") ?? SOURCES[0].url;
if (q.get("url")) { $("source").selectedIndex = SOURCES.length - 1; $("proj").value = "native"; }
await openSource();
if (q.get("crs")) { $("crs").value = q.get("crs"); $("crs").onchange(); }
