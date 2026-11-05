// A vector VRT in the browser: the XML is read by ogrvrt.js, each layer's
// sources are fetched over HTTP, and the layers are drawn on a web map
// with their features in a table. The format readers are other people's
// (flatgeobuf, hyparquet, proj4js, Leaflet); what this page adds is the
// VRT itself, read as GDAL reads it.
import {
  parseVRT, readLayer, layerName, toLonLat, styleFrom, transformBox, WGS84,
} from "./ogrvrt.js";

const CDN = "https://cdn.jsdelivr.net/npm";
const LIBS = {
  proj4: () => import(`${CDN}/proj4@2.22.0/+esm`).then((m) => m.default),
  flatgeobuf: () => import(`${CDN}/flatgeobuf@4.6.0/dist/esm/geojson.js/+esm`),
  hyparquet: () => import(`${CDN}/hyparquet@1.31.4/+esm`),
  compressors: () => import(`${CDN}/hyparquet-compressors@1.1.2/+esm`).then((m) => m.compressors),
};
const libs = {};
async function need(names) {
  await Promise.all(names.filter((n) => !libs[n]).map(async (n) => { libs[n] = await LIBS[n](); }));
}

const EXAMPLES = {
  antarctic: {
    file: "data/vrt/antarctic.vrt",
    label: "Two CSV files: points from columns, lines from WKT",
    hint: "Antarctic stations from longitude and latitude columns, coloured by an OGR style string in each row; " +
      "routes from Hobart as WKT in polar stereographic metres (EPSG:3031), drawn straight in that projection. " +
      "Station positions are approximate.",
  },
  countries: {
    file: "data/vrt/countries.vrt",
    label: "Remote GeoJSON, an SQL filter, three fields",
    hint: "Natural Earth countries (1:110m) read from GitHub over /vsicurl/, filtered by a SrcSQL WHERE, " +
      "with the FID taken from a field and three of the fields kept and renamed.",
  },
  union: {
    file: "data/vrt/union.vrt",
    label: "A union of a layer and a warped layer",
    hint: "Australian stations in longitude and latitude, and the others from a CSV in polar stereographic, " +
      "reprojected by an OGRVRTWarpedLayer, as one layer. The field named by SourceLayerFieldName says which.",
  },
  parquet: {
    file: "data/vrt/countries-parquet.vrt",
    label: "GeoParquet with a SrcRegion",
    hint: "Countries from a GeoParquet file (WKB), kept where they meet a rectangle around Australia " +
      "(not clipped to it).",
  },
  counties: {
    file: "data/vrt/uscounties.vrt",
    label: "FlatGeobuf, read by the view",
    home: [38.9, -77.0, 8],
    hint: "US counties from a 14 MB FlatGeobuf file on GitHub, in NAD83 (EPSG:4269). Its spatial index lets the " +
      "page fetch only the counties in the view, with range requests: pan and zoom to read more.",
  },
  url: { label: "A VRT at a URL", hint: "Any vector VRT served with CORS, and sources this page can read." },
};
const PALETTE = ["#3a7bd5", "#e8590c", "#2b8a3e", "#ae3ec9", "#0c8599", "#c2255c", "#5c940d", "#f08c00"];

const $ = (id) => document.getElementById(id);
function say(text, error = false) {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
}

// Requests and bytes, for the status line. Content-Length is readable
// cross-origin, so each response is counted as it arrives.
const io = { requests: 0, bytes: 0 };
const fetch0 = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await fetch0(...args);
  const method = (args[1] && args[1].method) || "GET";
  if (method !== "HEAD") {
    io.requests += 1;
    io.bytes += Number(res.headers.get("Content-Length")) || 0;
  }
  return res;
};
const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(2)} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);

// Map
const map = L.map("map", { zoomSnap: 0.25, worldCopyJump: true }).setView([-55, 140], 2);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);

// State: the parsed VRT, and per layer its spec, result and map layer.
let vrt = null;
let base = location.href;
let layers = [];  // {spec, name, colour, visible, result, group, error, byFid}
let shown = null; // index of the layer in the table
let picked = null;
const cache = new Map(); // whole-file sources, kept between reads

function styleFor(L0, f) {
  const s = (f.style && styleFrom(f.style)) || {};
  return { color: L0.colour, weight: 1.5, fillColor: L0.colour, fillOpacity: 0.15, radius: 5, ...s };
}

function draw(i) {
  const l = layers[i];
  if (l.group) { l.group.remove(); l.group = null; }
  l.byFid = new Map();
  if (!l.result || !l.visible) return;
  const gj = toLonLat(l.result, libs.proj4);
  l.group = L.geoJSON(gj, {
    style: (f) => styleFor(l, f),
    pointToLayer: (f, ll) => L.circleMarker(ll, styleFor(l, f)),
    onEachFeature: (f, lyr) => {
      l.byFid.set(f.id, lyr);
      lyr.on("click", () => { showTable(i); pick(f.id, false); });
      const name = Object.values(f.properties).find((v) => typeof v === "string");
      if (name) lyr.bindTooltip(String(name), { sticky: true });
    },
  }).addTo(map);
}

function lonlatBounds(l) {
  const r = l.result;
  if (!r) return null;
  if (r.features.length && l.group && l.group.getLayers().length && !r.byView) return l.group.getBounds();
  if (r.extent) {
    const b = transformBox(libs.proj4, r.extent, r.srs || WGS84, WGS84);
    if (b.every(isFinite)) return L.latLngBounds([b[1], b[0]], [b[3], b[2]]);
  }
  return l.group && l.group.getLayers().length ? l.group.getBounds() : null;
}

function listLayers() {
  const ul = $("layers");
  ul.textContent = "";
  if (!layers.length) { ul.innerHTML = '<li class="hint">None.</li>'; return; }
  layers.forEach((l, i) => {
    const li = document.createElement("li");
    if (i === shown) li.className = "on";
    const top = document.createElement("div");
    top.className = "top";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = l.visible;
    cb.onchange = () => { l.visible = cb.checked; draw(i); };
    const sw = document.createElement("span");
    sw.className = "sw";
    sw.style.background = l.colour;
    const b = document.createElement("b");
    b.textContent = l.name;
    b.title = "Show its features in the table";
    b.onclick = () => showTable(i);
    top.append(cb, sw, b);
    li.append(top);
    const meta = document.createElement("div");
    meta.className = "meta";
    const r = l.result;
    if (r) {
      const what = r.format === "union"
        ? `union of ${r.parts.map((p) => `${p.name} (${p.count}${p.warped ? `, warped ${p.warped.from} to ${p.warped.to}` : ""})`).join(", ")}`
        : `${r.format}${r.warped ? `, warped ${r.warped.from} to ${r.warped.to}` : ""}`;
      meta.textContent = `${r.features.length} feature${r.features.length === 1 ? "" : "s"}` +
        `${r.byView ? " in the view" : ""}${r.truncated ? " (the first ones only)" : ""}; ${r.fields.length} fields; ` +
        `${r.srs ? r.srs.label : "no SRS"}; ${what}`;
      li.append(meta);
      const acts = document.createElement("div");
      acts.className = "acts";
      const btn = (text, title, fn) => {
        const x = document.createElement("button");
        x.textContent = text;
        x.title = title;
        x.onclick = fn;
        acts.append(x);
      };
      btn("Zoom", "Zoom to the layer", () => {
        const bb = lonlatBounds(l);
        if (bb) map.fitBounds(bb, { padding: [20, 20] });
      });
      btn("GeoJSON", "Download the layer as read, in longitude and latitude", () => {
        const blob = new Blob([JSON.stringify(toLonLat(l.result, libs.proj4))], { type: "application/geo+json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${l.name}.geojson`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      });
      btn("Edit", "Open the layer in the editing canvas", () => {
        const blob = new Blob([JSON.stringify(toLonLat(l.result, libs.proj4))], { type: "application/geo+json" });
        window.open(`edit.html?url=${encodeURIComponent(URL.createObjectURL(blob))}`, "_blank");
      });
      li.append(acts);
    } else if (l.error) {
      const e = document.createElement("div");
      e.className = "err";
      e.textContent = l.error;
      li.append(e);
    } else {
      meta.textContent = "reading...";
      li.append(meta);
    }
    ul.append(li);
  });
}

function showNotes() {
  const all = [...(vrt ? vrt.notes : [])];
  for (const l of layers) if (l.result) all.push(...l.result.notes);
  const uniq = [...new Set(all)];
  $("noteblock").hidden = !uniq.length;
  $("notes").textContent = "";
  for (const n of uniq) {
    const li = document.createElement("li");
    li.textContent = n;
    $("notes").append(li);
  }
}

function showTable(i) {
  shown = i;
  picked = null;
  const box = $("table");
  const l = layers[i];
  listLayers();
  if (!l || !l.result) { box.innerHTML = '<div class="empty">No features.</div>'; return; }
  const r = l.result;
  if (!r.features.length) { box.innerHTML = '<div class="empty">No features (in the view).</div>'; return; }
  const MAX = 2000;
  const t = document.createElement("table");
  const head = t.createTHead().insertRow();
  for (const name of ["FID", ...r.fields.map((f) => f.name), "geometry"]) {
    const th = document.createElement("th");
    th.textContent = name;
    head.append(th);
  }
  const body = t.createTBody();
  for (const f of r.features.slice(0, MAX)) {
    const tr = body.insertRow();
    tr.dataset.fid = f.fid;
    const cell = (v) => {
      const td = tr.insertCell();
      if (typeof v === "number") td.className = "num";
      td.textContent = v === null || v === undefined ? "" : String(v);
    };
    cell(f.fid);
    for (const fd of r.fields) cell(f.properties[fd.name]);
    cell(f.geometry ? f.geometry.type : "");
    tr.onclick = () => pick(f.fid, true);
  }
  box.textContent = "";
  box.append(t);
  if (r.features.length > MAX) {
    const p = document.createElement("div");
    p.className = "empty";
    p.textContent = `Showing ${MAX} of ${r.features.length} features.`;
    box.append(p);
  }
}

function pick(fid, fromTable) {
  const l = layers[shown];
  if (!l) return;
  if (picked !== null) {
    const old = l.byFid.get(picked);
    if (old && old.setStyle) old.setStyle(styleFor(l, old.feature));
    $("table").querySelector(`tr[data-fid="${CSS.escape(String(picked))}"]`)?.classList.remove("on");
  }
  picked = fid;
  const lyr = l.byFid.get(fid);
  if (lyr && lyr.setStyle) lyr.setStyle({ color: "#d70015", weight: 3, fillOpacity: 0.35, radius: 8 });
  if (lyr && lyr.bringToFront) lyr.bringToFront();
  const tr = $("table").querySelector(`tr[data-fid="${CSS.escape(String(fid))}"]`);
  if (tr) {
    tr.classList.add("on");
    if (!fromTable) tr.scrollIntoView({ block: "nearest" });
  }
  if (fromTable && lyr) {
    const b = lyr.getBounds ? lyr.getBounds() : L.latLngBounds([lyr.getLatLng(), lyr.getLatLng()]);
    if (!map.getBounds().contains(b)) map.fitBounds(b, { maxZoom: Math.max(map.getZoom(), 6), padding: [20, 20] });
  }
}

function viewBox() {
  const b = map.getBounds();
  const w = Math.max(-180, b.getWest()), e = Math.min(180, b.getEast());
  return [w, Math.max(-90, b.getSouth()), e, Math.min(90, b.getNorth())];
}

function formats(spec, out = new Set()) {
  if (spec.kind === "layer") out.add(spec.src.format);
  else if (spec.kind === "warped") formats(spec.layer, out);
  else spec.layers.forEach((x) => formats(x, out));
  return out;
}

let generation = 0;
async function readAll({ onlyByView = false } = {}) {
  const gen = ++generation;
  const t0 = performance.now();
  const r0 = { ...io };
  const todo = layers.map((l, i) => i).filter((i) => !onlyByView || (layers[i].result && layers[i].result.byView));
  if (!todo.length) return;
  say(onlyByView ? "Reading the view..." : "Reading the layers...");
  await Promise.all(todo.map(async (i) => {
    const l = layers[i];
    try {
      const result = await readLayer(l.spec, { libs, view: viewBox(), cache, limit: 20000 });
      if (gen !== generation) return;
      l.result = result;
      l.error = null;
    } catch (e) {
      if (gen !== generation) return;
      l.result = null;
      l.error = e.message || String(e);
      console.error(e);
    }
    draw(i);
  }));
  if (gen !== generation) return;
  listLayers();
  showNotes();
  if (shown !== null) showTable(shown);
  const n = layers.reduce((s, l) => s + (l.result ? l.result.features.length : 0), 0);
  const bad = layers.filter((l) => l.error).length;
  say(`${n} features in ${layers.length} layer${layers.length === 1 ? "" : "s"}` +
    `${bad ? ` (${bad} could not be read)` : ""}, ${((performance.now() - t0) / 1000).toFixed(1)} s, ` +
    `${io.requests - r0.requests} requests, ${mb(io.bytes - r0.bytes)}.`, bad > 0 && bad === layers.length);
}

async function open(text, at, home) {
  generation++;
  for (const l of layers) if (l.group) l.group.remove();
  layers = [];
  shown = null;
  base = at;
  $("table").innerHTML = '<div class="empty">Pick a layer to see its features here.</div>';
  try {
    vrt = parseVRT(text, base);
  } catch (e) {
    vrt = null;
    listLayers();
    showNotes();
    say(e.message, true);
    return;
  }
  const fmts = new Set();
  vrt.layers.forEach((s) => formats(s, fmts));
  try {
    await need(["proj4", ...(fmts.has("flatgeobuf") ? ["flatgeobuf"] : []), ...(fmts.has("parquet") ? ["hyparquet", "compressors"] : [])]);
  } catch (e) {
    say(`Could not load a library: ${e.message}`, true);
    return;
  }
  layers = vrt.layers.map((spec, i) => ({ spec, name: layerName(spec), colour: PALETTE[i % PALETTE.length], visible: true }));
  listLayers();
  if (home) map.setView([home[0], home[1]], home[2]);
  await readAll();
  if (!home) {
    let bb = null;
    for (const l of layers) {
      const b = lonlatBounds(l);
      if (b) bb = bb ? bb.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
    }
    if (bb && bb.isValid()) {
      map.fitBounds(bb, { padding: [20, 20] });
      // A layer read by the view is read again for the view it now has.
      if (layers.some((l) => l.result && l.result.byView)) await readAll({ onlyByView: true });
    }
  }
  if (layers.length && shown === null) showTable(0);
}

let moving = null;
map.on("moveend", () => {
  if (!$("follow").checked || !layers.some((l) => l.result && l.result.byView)) return;
  clearTimeout(moving);
  moving = setTimeout(() => readAll({ onlyByView: true }), 250);
});

// Examples and the URL box
const sel = $("preset");
for (const [k, p] of Object.entries(EXAMPLES)) sel.add(new Option(p.label, k));

async function loadPreset(key, url) {
  const p = EXAMPLES[key];
  $("presethint").textContent = p.hint;
  $("urlrow").hidden = key !== "url";
  if (key === "url") {
    if (url) $("url").value = url;
    if (!$("url").value) { $("xml").value = ""; say("Paste the address of a VRT."); return; }
    await fetchAndOpen($("url").value.trim());
    return;
  }
  await fetchAndOpen(new URL(p.file, location.href).href, p.home);
}

async function fetchAndOpen(url, home) {
  say("Fetching the VRT...");
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    $("xml").value = await res.text();
  } catch (e) {
    say(e.message || String(e), true);
    return;
  }
  await open($("xml").value, url, home);
}

sel.onchange = () => {
  const q = new URLSearchParams(location.search);
  q.delete("vrt");
  q.set("example", sel.value);
  history.replaceState(null, "", `?${q}`);
  loadPreset(sel.value);
};
$("url").onkeydown = (e) => { if (e.key === "Enter") loadPreset("url"); };
$("open").onclick = () => {
  if (sel.value === "url" && $("url").value.trim() && !$("xml").value.trim()) { loadPreset("url"); return; }
  open($("xml").value, base);
};

const q = new URLSearchParams(location.search);
if (q.get("vrt")) {
  sel.value = "url";
  loadPreset("url", q.get("vrt"));
} else {
  sel.value = EXAMPLES[q.get("example")] ? q.get("example") : "antarctic";
  loadPreset(sel.value);
}
