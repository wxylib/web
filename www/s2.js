// Sentinel-2 browser: STAC search, then each band of the chosen scene is
// warped by wxy-warp (wasm) onto the map's own Web Mercator pixel grid
// whenever the map moves. Scaling to colour happens here, so the stretch
// sliders repaint without warping again.
import init, { Cog } from "./pkg/wxy_web.js";

const STAC = "https://earth-search.aws.element84.com/v1/search";
const COLLECTION = "sentinel-2-l2a";
const MAX_SIDE = 2048; // cap on the warped grid, in cells

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
const footprints = L.geoJSON(null, {
  style: { color: "#3a7bd5", weight: 1, fillOpacity: 0.04 },
  onEachFeature: (f, layer) => layer.on("click", () => select(f)),
}).addTo(map);
let overlay = null;

// State: the chosen scene, its opened bands, and the last warp
let scene = null;      // { item, cogs: Map(key -> Promise<Cog>) }
let last = null;       // { vals: [Float32Array x3], w, h, ext, keys }
let busy = false, again = false;

// The map's view as an extent in EPSG:3857 metres, [xmin, xmax, ymin, ymax],
// and the size of one screen pixel in metres.
function viewExtent() {
  const b = map.getBounds(), P = (ll) => L.CRS.EPSG3857.project(ll);
  const sw = P(b.getSouthWest()), ne = P(b.getNorthEast());
  return { ext: [sw.x, ne.x, sw.y, ne.y], res: (ne.x - sw.x) / map.getSize().x };
}

function cog(key) {
  if (!scene.cogs.has(key)) {
    const href = scene.item.assets[key].href;
    scene.cogs.set(key, Cog.open(href).then((c) => ({ c, bounds: c.bounds("EPSG:3857") })));
  }
  return scene.cogs.get(key);
}

// Warp the current scene's three bands onto the visible part of the map.
async function render() {
  if (!scene) return;
  if (busy) { again = true; return; }
  busy = true;
  try {
    const keys = $("combo").value.split(",");
    const alg = $("resampling").value;
    const bands = await Promise.all(keys.map(cog));
    const { ext: v, res } = viewExtent();
    const s = bands[0].bounds;
    const ext = [Math.max(v[0], s[0]), Math.min(v[1], s[1]), Math.max(v[2], s[2]), Math.min(v[3], s[3])];
    if (ext[0] >= ext[1] || ext[2] >= ext[3]) {
      if (overlay) { overlay.remove(); overlay = null; }
      say("The scene is outside the view.");
      return;
    }
    let w = Math.ceil((ext[1] - ext[0]) / res), h = Math.ceil((ext[3] - ext[2]) / res);
    const k = Math.min(1, MAX_SIDE / Math.max(w, h));
    w = Math.max(1, Math.round(w * k)); h = Math.max(1, Math.round(h * k));
    say(`Warping ${w} x ${h} cells...`);
    const t0 = performance.now();
    const outs = await Promise.all(bands.map((b) => b.c.warp("EPSG:3857", ext, w, h, alg)));
    const ms = performance.now() - t0;
    last = { vals: outs.map((o) => o.values), w, h, ext, keys };
    paint();
    const req = outs.reduce((a, o) => a + o.requests, 0), mb = outs.reduce((a, o) => a + o.bytes, 0) / 1e6;
    const lv = outs.map((o) => o.level === 0 ? "full" : "ovr " + o.level).join(", ");
    say(`${scene.item.id}\n${w} x ${h} cells, ${alg}, ${ms.toFixed(0)} ms for 3 bands.\n` +
        `Levels read: ${lv}. Range requests for this scene: ${req}, ${mb.toFixed(1)} MB.`);
  } catch (e) {
    say(String(e.message || e), true);
  } finally {
    busy = false;
    if (again) { again = false; render(); }
  }
}

// Scale the last warp to colour: reflectance = DN * scale + offset (from
// the STAC item's raster:bands), stretched black..white, then gamma.
function paint() {
  if (!last) return;
  const { vals, w, h, ext, keys } = last;
  const lo = +$("lo").value, hi = +$("hi").value, g = 1 / +$("gamma").value;
  const so = keys.map((k) => {
    const rb = (scene.item.assets[k]["raster:bands"] || [{}])[0];
    // Earth Search has already removed the BOA offset when this is set,
    // though raster:bands still lists it
    const applied = scene.item.properties["earthsearch:boa_offset_applied"];
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
  const U = (x, y) => L.CRS.EPSG3857.unproject(L.point(x, y));
  const bounds = L.latLngBounds(U(ext[0], ext[2]), U(ext[1], ext[3]));
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    if (overlay) {
      URL.revokeObjectURL(overlay._url);
      overlay.setUrl(url).setBounds(bounds);
    } else {
      overlay = L.imageOverlay(url, bounds, { interactive: false }).addTo(map);
    }
  });
}

function select(item) {
  if (scene) for (const p of scene.cogs.values()) p.then((b) => b.c.free()).catch(() => {});
  scene = { item, cogs: new Map() };
  last = null;
  for (const li of $("scenes").children) li.classList.toggle("on", li.dataset.id === item.id);
  render();
}

async function search() {
  const b = map.getBounds();
  const body = {
    collections: [COLLECTION],
    bbox: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => +x.toFixed(4)),
    datetime: `${$("from").value}T00:00:00Z/${$("to").value}T23:59:59Z`,
    query: { "eo:cloud_cover": { lt: +$("cloud").value } },
    sortby: [{ field: "properties.datetime", direction: "desc" }],
    limit: 50,
  };
  say("Searching " + COLLECTION + "...");
  let items;
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
  const ul = $("scenes");
  ul.replaceChildren();
  for (const it of items) {
    const p = it.properties, li = document.createElement("li");
    li.dataset.id = it.id;
    const img = document.createElement("img");
    img.loading = "lazy"; img.alt = "";
    img.src = it.assets.thumbnail?.href ?? "";
    const tile = `${p["mgrs:utm_zone"] ?? ""}${p["mgrs:latitude_band"] ?? ""}${p["mgrs:grid_square"] ?? ""}`;
    const txt = document.createElement("div");
    txt.innerHTML = `${p.datetime.slice(0, 10)}<br><small>tile ${tile}, cloud ${(+p["eo:cloud_cover"]).toFixed(1)}%</small>`;
    li.append(img, txt);
    li.onclick = () => { select(it); };
    ul.append(li);
  }
  say(items.length ? `${items.length} scenes. Pick one from the list or the map.` : "No scenes; widen the dates or the cloud limit.");
  if (items.length && !scene) select(items[0]);
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
for (const id of ["lo", "hi", "gamma"]) $(id).oninput = () => { show(); paint(); };
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
map.on("moveend", render);

await init();
const q = new URLSearchParams(location.search);
if (q.get("from")) $("from").value = q.get("from");
if (q.get("to")) $("to").value = q.get("to");
search();
