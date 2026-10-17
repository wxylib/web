// Sentinel-2 browser: STAC search, then the chosen scene (or every scene
// of a solar day) is warped by wxy-warp (wasm) onto the map's own Web
// Mercator pixel grid whenever the map moves. The view is cut into blocks
// that load from the centre outward, nearest scene first, each painted as
// it lands. Scaling to colour happens here, so the stretch sliders repaint
// without warping again.
import init, { Cog } from "./pkg/wxy_web.js";

const STAC = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-2-l2a";
const BLOCK = 256; // screen pixels per block side
const WORKERS = 3; // blocks in flight at once (their fetches overlap)

const $ = (id) => document.getElementById(id);
const status = $("status");
function say(text, error = false) {
  status.textContent = text;
  status.className = error ? "error" : "";
}

// Map, basemap and scene footprints
const map = L.map("map", { zoomSnap: 0.25 }).setView([-42.9, 147.3], 9);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; ' +
    'Sentinel-2 via <a href="https://element84.com/earth-search/">Earth Search</a>',
}).addTo(map);
const FOOT = { color: "#3a7bd5", weight: 1, fillOpacity: 0.04 };
const FOOT_ON = { color: "#e8590c", weight: 2, fillOpacity: 0 };
const footprints = L.geoJSON(null, {
  style: FOOT,
  onEachFeature: (f, layer) => layer.on("click", () => choose([f], f.id)),
}).addTo(map);

// State
let items = [];        // search results
let sel = null;        // { items, label, cogs: Map(href -> Promise<{c, bounds}>), bytes: Map(href -> n) }
let layer = null;      // the L.layerGroup of painted blocks for the current load
let blocks = [];       // painted blocks: { vals, w, h, ext, item, keys, overlay }
let gen = 0;           // bumped by every new load and by Stop
let loading = false;

const P = (lon, lat) => L.CRS.EPSG3857.project(L.latLng(lat, lon));
const U = (x, y) => L.CRS.EPSG3857.unproject(L.point(x, y));

// Local solar date of an item: UTC time shifted by the scene's longitude.
function solarDay(it) {
  const b = it.bbox, lon = (b[0] + b[2]) / 2;
  return new Date(Date.parse(it.properties.datetime) + lon * 240e3).toISOString().slice(0, 10);
}

// An item's bbox in EPSG:3857 (for planning; the exact bounds come from
// the COG when it is opened).
function itemExtent(it) {
  const b = it.bbox, a = P(b[0], b[1]), c = P(b[2], b[3]);
  return [a.x, c.x, a.y, c.y];
}

function cog(href) {
  if (!sel.cogs.has(href)) {
    sel.cogs.set(href, Cog.open(href).then((c) => ({ c, bounds: c.bounds("EPSG:3857") })));
  }
  return sel.cogs.get(href);
}

let held = false;
function hold(on) {
  held = on;
  const hs = [map.dragging, map.scrollWheelZoom, map.doubleClickZoom, map.touchZoom, map.boxZoom, map.keyboard];
  for (const h of hs) on ? h.disable() : h.enable();
  map.zoomControl.getContainer().style.display = on ? "none" : "";
}

function finish(text, error = false) {
  loading = false;
  hold(false);
  $("stop").disabled = true;
  say(text, error);
}

// Load the selection into the view: blocks of the view grid, ordered by
// distance from the centre, crossed with the selected scenes nearest the
// centre, warped a few at a time.
async function render() {
  if (!sel) return;
  const my = ++gen;
  const keys = $("combo").value.split(",");
  const alg = $("resampling").value;
  const size = map.getSize();
  const b = map.getBounds(), sw = P(b.getWest(), b.getSouth()), ne = P(b.getEast(), b.getNorth());
  const res = (ne.x - sw.x) / size.x;
  const [vx0, vy1] = [sw.x, ne.y]; // view origin: top left
  const cx = (sw.x + ne.x) / 2, cy = (sw.y + ne.y) / 2;
  const dist = (e) => Math.hypot((e[0] + e[1]) / 2 - cx, (e[2] + e[3]) / 2 - cy);

  // scenes in view, nearest first, capped
  const inView = (e) => e[0] < ne.x && e[1] > sw.x && e[2] < ne.y && e[3] > sw.y;
  const scenes = sel.items.map((it) => ({ it, e: itemExtent(it) })).filter((s) => inView(s.e))
    .sort((p, q) => dist(p.e) - dist(q.e)).slice(0, Math.max(1, +$("maxScenes").value));
  if (!scenes.length) {
    if (layer) { layer.remove(); layer = null; }
    blocks = [];
    finish("The selection is outside the view.");
    return;
  }
  footprints.setStyle((f) => scenes.some((s) => s.it.id === f.id) ? FOOT_ON : FOOT);

  // blocks of the view, in screen pixels, nearest the centre first
  const jobs = [];
  for (let y0 = 0; y0 < size.y; y0 += BLOCK) {
    for (let x0 = 0; x0 < size.x; x0 += BLOCK) {
      const x1 = Math.min(size.x, x0 + BLOCK), y1 = Math.min(size.y, y0 + BLOCK);
      const e = [vx0 + x0 * res, vx0 + x1 * res, vy1 - y1 * res, vy1 - y0 * res];
      for (const [k, s] of scenes.entries()) {
        if (s.e[0] < e[1] && s.e[1] > e[0] && s.e[2] < e[3] && s.e[3] > e[2]) {
          jobs.push({ px: [x0, x1, y0, y1], d: dist(e), k, it: s.it });
        }
      }
    }
  }
  jobs.sort((p, q) => p.d - q.d || p.k - q.k);

  // the previous load stays on screen until this one is done
  const old = layer;
  layer = L.layerGroup().addTo(map);
  blocks = [];
  loading = true;
  $("stop").disabled = false;
  if ($("hold").checked) hold(true);
  const cap = +$("maxMB").value * 1e6;
  const t0 = performance.now();
  let done = 0, next = 0, capped = false;
  const mb = () => [...sel.bytes.values()].reduce((a, n) => a + n, 0);
  const progress = () => say(`${sel.label}: ${scenes.length} scene${scenes.length > 1 ? "s" : ""}, ` +
    `block ${done} of ${jobs.length}, ${(mb() / 1e6).toFixed(1)} MB read.`);
  progress();

  async function run(job) {
    const hrefs = keys.map((k) => job.it.assets[k].href);
    const bands = await Promise.all(hrefs.map(cog));
    if (my !== gen) return;
    // the block, cut to the scene's exact bounds, snapped to whole pixels
    const s = bands[0].bounds, [x0, x1, y0, y1] = job.px;
    const px0 = Math.max(x0, Math.floor((s[0] - vx0) / res)), px1 = Math.min(x1, Math.ceil((s[1] - vx0) / res));
    const py0 = Math.max(y0, Math.floor((vy1 - s[3]) / res)), py1 = Math.min(y1, Math.ceil((vy1 - s[2]) / res));
    if (px0 >= px1 || py0 >= py1) return;
    const w = px1 - px0, h = py1 - py0;
    const ext = [vx0 + px0 * res, vx0 + px1 * res, vy1 - py1 * res, vy1 - py0 * res];
    const outs = await Promise.all(bands.map((bd) => bd.c.warp("EPSG:3857", ext, w, h, alg)));
    if (my !== gen) return;
    outs.forEach((o, i) => sel.bytes.set(hrefs[i], o.bytes));
    const blk = { vals: outs.map((o) => o.values), w, h, ext, item: job.it, keys, overlay: null };
    blocks.push(blk);
    paintBlock(blk);
  }

  async function worker() {
    while (next < jobs.length && my === gen) {
      if (mb() > cap) { capped = true; return; }
      const job = jobs[next++];
      try {
        await run(job);
      } catch (e) {
        if (my === gen) { gen++; finish(String(e.message || e), true); }
        return;
      }
      done++;
      if (my === gen) progress();
    }
  }
  await Promise.all(Array.from({ length: WORKERS }, worker));
  if (old) old.remove();
  if (my !== gen) return; // superseded or stopped
  const secs = ((performance.now() - t0) / 1e3).toFixed(1);
  finish(`${sel.label}: ${scenes.length} scene${scenes.length > 1 ? "s" : ""}, ${done} of ${jobs.length} blocks ` +
    `in ${secs} s, ${alg}. ${(mb() / 1e6).toFixed(1)} MB read for this selection.` +
    (capped ? `\nStopped at the ${$("maxMB").value} MB cap; raise it or zoom in.` : ""));
}

// Scale a block to colour: reflectance = DN * scale + offset (from the
// STAC item's raster:bands), stretched black..white, then gamma.
function paintBlock(blk) {
  const { vals, w, h, ext, keys, item } = blk;
  const lo = +$("lo").value, hi = +$("hi").value, g = 1 / +$("gamma").value;
  // Earth Search has already removed the BOA offset when this is set,
  // though raster:bands still lists it
  const applied = item.properties["earthsearch:boa_offset_applied"];
  const so = keys.map((k) => {
    const rb = (item.assets[k]["raster:bands"] || [{}])[0];
    return [rb.scale ?? 1e-4, applied ? 0 : rb.offset ?? 0];
  });
  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext("2d"), img = ctx.createImageData(w, h), px = img.data;
  const span = hi - lo || 1e-6;
  for (let i = 0; i < w * h; i++) {
    let any = false;
    for (let b = 0; b < 3; b++) {
      const v = vals[b][i];
      if (!Number.isFinite(v)) continue; // nodata (0) or outside the scene
      any = true;
      const t = Math.min(1, Math.max(0, (v * so[b][0] + so[b][1] - lo) / span));
      px[4 * i + b] = 255 * Math.pow(t, g);
    }
    px[4 * i + 3] = any ? 255 : 0;
  }
  ctx.putImageData(img, 0, 0);
  const bounds = L.latLngBounds(U(ext[0], ext[2]), U(ext[1], ext[3]));
  const target = layer;
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    if (blk.overlay) {
      URL.revokeObjectURL(blk.overlay._url);
      blk.overlay.setUrl(url);
    } else {
      blk.overlay = L.imageOverlay(url, bounds, { interactive: false }).addTo(target);
    }
  });
}

function repaint() {
  for (const blk of blocks) paintBlock(blk);
}

// Select one scene or a day of scenes, dropping the last selection's files.
function choose(list, label) {
  if (sel) for (const p of sel.cogs.values()) p.then((b) => b.c.free()).catch(() => {});
  sel = { items: list, label, cogs: new Map(), bytes: new Map() };
  for (const li of $("scenes").children) li.classList.toggle("on", li.dataset.id === label);
  render();
}

function listScenes() {
  const ul = $("scenes");
  ul.replaceChildren();
  const row = (id, thumb, title, sub, onclick) => {
    const li = document.createElement("li");
    li.dataset.id = id;
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = "";
    img.src = thumb ?? "";
    const txt = document.createElement("div");
    txt.innerHTML = `${title}<br><small>${sub}</small>`;
    li.append(img, txt);
    li.onclick = onclick;
    li.classList.toggle("on", sel?.label === id);
    ul.append(li);
  };
  const tileOf = (p) => `${p["mgrs:utm_zone"] ?? ""}${p["mgrs:latitude_band"] ?? ""}${p["mgrs:grid_square"] ?? ""}`;
  if ($("byday").checked) {
    const days = new Map();
    for (const it of items) {
      const d = solarDay(it);
      if (!days.has(d)) days.set(d, []);
      days.get(d).push(it);
    }
    for (const [d, its] of [...days.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      const cloud = its.reduce((a, it) => a + +it.properties["eo:cloud_cover"], 0) / its.length;
      const tiles = [...new Set(its.map((it) => tileOf(it.properties)))].sort().join(" ");
      row("day:" + d, its[0].assets.thumbnail?.href, `${d}, ${its.length} scene${its.length > 1 ? "s" : ""}`,
        `${tiles}; mean cloud ${cloud.toFixed(1)}%`, () => choose(its, "day:" + d));
    }
  } else {
    for (const it of items) {
      const p = it.properties;
      row(it.id, it.assets.thumbnail?.href, p.datetime.slice(0, 10),
        `tile ${tileOf(p)}, cloud ${(+p["eo:cloud_cover"]).toFixed(1)}%`, () => choose([it], it.id));
    }
  }
}

async function search() {
  const b = map.getBounds();
  const body = {
    collections: [COLLECTION],
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => +x.toFixed(4)),
    datetime: `${$("from").value}T00:00:00Z/${$("to").value}T23:59:59Z`,
    query: { "eo:cloud_cover": { lt: +$("cloud").value } },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    limit: 100,
  };
  say("Searching " + COLLECTION + "...");
  try {
    const r = await fetch(STAC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`STAC search: HTTP ${r.status}`);
    items = (await r.json()).features;
  } catch (e) {
    say(String(e.message || e), true);
    return;
  }
  footprints.clearLayers();
  footprints.addData(items);
  listScenes();
  say(items.length ? `${items.length} scenes. Pick one (or a day) from the list or the map.` :
    "No scenes; widen the dates or the cloud limit.");
  if (items.length && !sel) choose([items[0]], items[0].id);
}

// Controls
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
$("to").value = iso(today);
$("from").value = iso(new Date(today - 60 * 864e5));
const show = () => {
  $("cloudv").value = $("cloud").value + "%";
  $("lov").value = (+$("lo").value).toFixed(2);
  $("hiv").value = (+$("hi").value).toFixed(2);
  $("gammav").value = (+$("gamma").value).toFixed(2);
};
show();
for (const id of ["lo", "hi", "gamma"]) $(id).oninput = () => { show(); repaint(); };
$("cloud").oninput = show;
$("search").onclick = search;
// a white point per band set (reflectance): visible bands are darker
const WHITE = { "red,green,blue": 0.25, "nir,red,green": 0.45, "swir22,nir08,red": 0.45, "swir16,nir,blue": 0.45 };
$("combo").onchange = () => {
  $("hi").value = WHITE[$("combo").value] ?? 0.3;
  show();
  render();
};
$("resampling").onchange = render;
$("byday").onchange = listScenes;
$("stop").onclick = () => {
  gen++;
  finish(`Stopped: ${blocks.length} blocks drawn. Move the map or pick again to load more.`);
};
map.on("moveend", () => { if (!held) render(); });

await init();
const q = new URLSearchParams(location.search);
if (q.get("from")) $("from").value = q.get("from");
if (q.get("to")) $("to").value = q.get("to");
if (q.get("byday")) $("byday").checked = true;
search();
