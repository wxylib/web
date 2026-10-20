// GeoParquet in the browser: SQL by DuckDB (wasm) over remote files, read
// with HTTP range requests; the result is shown as a table, and its WKB
// geometry column is decoded here and drawn on the map. Nothing in this
// page is wxylib code: vector query is a solved problem (design m09), so
// this example shows the piece wxylib hands vector work to.
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.32.0/+esm";
import { wkbToGeoJSON } from "./wkb.js";

const OVERTURE = "https://overturemaps-us-west-2.s3.amazonaws.com";
const STAC = "https://stac.overturemaps.org";
const MAX_ROWS = 5000; // rows kept from a result, for the table and the map

// Overture's files are each a region of the world. The STAC catalog gives
// each file's bbox, so a query opens only the files the view meets; DuckDB
// then reads those files' footers and, from the row group bbox statistics,
// only the row groups and columns the query needs.
const PRESETS = {
  buildings: {
    label: "Overture buildings (polygons)",
    stac: "buildings/building",
    s3: "theme=buildings/type=building",
    hint: "Building footprints from Overture Maps, latest release: 512 files, about 230 GB. " +
      "A city-block view opens one of them, reads its footer (about 1.5 MB) and the few row groups " +
      "the view meets. Keep the view small: the filter is the view.",
    sql: `SELECT id, names.primary AS name, subtype, class,
  height, num_floors, geometry
FROM read_parquet({files})
WHERE bbox.xmin < {xmax} AND bbox.xmax > {xmin}
  AND bbox.ymin < {ymax} AND bbox.ymax > {ymin}
LIMIT 3000`,
  },
  places: {
    label: "Overture places (points)",
    stac: "places/place",
    s3: "theme=places/type=place",
    allowAll: true,
    hint: "Points of interest from Overture Maps, latest release: 16 files, about 11 GB. " +
      "The view usually meets one or two files (about 2 MB of footer each).",
    sql: `SELECT id, names.primary AS name, basic_category AS category,
  round(confidence, 2) AS confidence, geometry
FROM read_parquet({files})
WHERE bbox.xmin < {xmax} AND bbox.xmax > {xmin}
  AND bbox.ymin < {ymax} AND bbox.ymax > {ymin}
LIMIT 2000`,
  },
  url: {
    label: "A GeoParquet file at a URL",
    hint: "Any GeoParquet (or Parquet with a WKB column called geometry) served with CORS and range requests. " +
      "Several URLs separated by spaces, or a numbered set such as part_{00000..00123}.parquet, are one source: " +
      "the first query reads every footer for the files' bboxes, later ones open only the files the view meets.",
    sql: `SELECT *
FROM read_parquet({files})
LIMIT 500`,
  },
};

const $ = (id) => document.getElementById(id);
const status = $("status");
function say(text, error = false) {
  status.textContent = text;
  status.className = error ? "error" : "";
}

// Map
const map = L.map("map", { zoomSnap: 0.25 }).setView([-42.8826, 147.3277], 17);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors; ' +
    'data &copy; <a href="https://overturemaps.org">Overture Maps Foundation</a>',
}).addTo(map);
const STYLE = { color: "#3a7bd5", weight: 1.5, fillOpacity: 0.12, radius: 4 };
const STYLE_ON = { color: "#e8590c", weight: 3, fillOpacity: 0.3, radius: 7 };
let shapes = null;     // L.geoJSON layer of the result
let byRow = new Map(); // result row -> Leaflet layer
let picked = null;     // row index on show

// Byte counting: the DuckDB worker reads files with XMLHttpRequest, so a
// prelude in the worker reports each request on a channel.
const IO_PRELUDE = `
const wxyIO = new BroadcastChannel("wxy-io");
const xhrOpen = XMLHttpRequest.prototype.open;
const xhrSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function (method, url, ...rest) {
  this.wxy = { method, url: String(url), done: false };
  return xhrOpen.call(this, method, url, ...rest);
};
XMLHttpRequest.prototype.send = function (...args) {
  const report = () => {
    if (!this.wxy || this.wxy.done) return;
    this.wxy.done = true;
    const r = this.response;
    const bytes = r && r.byteLength !== undefined ? r.byteLength : 0;
    wxyIO.postMessage({ method: this.wxy.method, url: this.wxy.url, bytes });
  };
  this.addEventListener("loadend", report);
  const out = xhrSend.apply(this, args);
  if (this.readyState === 4) report();
  return out;
};
`;
const io = { requests: 0, bytes: 0 };
new BroadcastChannel("wxy-io").onmessage = (e) => {
  if (/duckdb_extension/.test(e.data.url)) return;
  io.requests += 1;
  io.bytes += e.data.bytes;
};

// DuckDB
let conn = null;
async function start() {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const src = `${IO_PRELUDE}\nimportScripts(${JSON.stringify(bundle.mainWorker)});`;
  const workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  URL.revokeObjectURL(workerUrl);
  conn = await db.connect();
  // Keep Parquet footers between queries, so only the first one reads them.
  for (const s of ["SET enable_object_cache = true", "SET enable_http_metadata_cache = true"]) {
    try { await conn.query(s); } catch (e) { /* not in every build */ }
  }
}

// File lists. The release is looked up, not written in: Overture removes
// old releases after a few months.
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// From the STAC catalog: every file of a theme with its bbox. Kept in the
// browser per release, since a theme can have hundreds of items.
async function stacFiles(path) {
  const root = await getJSON(`${STAC}/catalog.json`);
  const release = root.latest;
  if (!release) throw new Error("the STAC catalog names no latest release");
  const key = `wxy-stac:${release}:${path}`;
  try {
    const kept = localStorage.getItem(key);
    if (kept) return { release, files: JSON.parse(kept) };
  } catch (e) { /* storage blocked */ }
  const coll = await getJSON(`${STAC}/${release}/${path}/collection.json`);
  const hrefs = coll.links.filter((l) => l.rel === "item").map((l) => new URL(l.href, `${STAC}/${release}/${path}/`).href);
  const files = [];
  for (let i = 0; i < hrefs.length; i += 32) {
    const items = await Promise.all(hrefs.slice(i, i + 32).map(getJSON));
    for (const it of items) {
      const a = it.assets.aws || Object.values(it.assets).find((x) => /^https:/.test(x.href));
      files.push({ url: a.href, bbox: it.bbox });
    }
  }
  try { localStorage.setItem(key, JSON.stringify(files)); } catch (e) { /* storage full or blocked */ }
  return { release, files };
}

// From the bucket listing (it allows CORS): every file, no bboxes.
async function s3list(prefix, delimiter = "") {
  const out = [];
  let token = "";
  for (;;) {
    const q = new URLSearchParams({ "list-type": "2", prefix });
    if (delimiter) q.set("delimiter", delimiter);
    if (token) q.set("continuation-token", token);
    const res = await fetch(`${OVERTURE}/?${q}`);
    if (!res.ok) throw new Error(`listing ${prefix}: HTTP ${res.status}`);
    const xml = new DOMParser().parseFromString(await res.text(), "application/xml");
    const texts = (tag) => [...xml.getElementsByTagName(tag)].map((n) => n.textContent);
    out.push(...(delimiter ? texts("Prefix").filter((p) => p !== prefix) : texts("Key")));
    if (texts("IsTruncated")[0] !== "true") return out;
    token = texts("NextContinuationToken")[0];
  }
}
async function s3Files(prefix) {
  const releases = (await s3list("release/", "/")).sort();
  const release = releases[releases.length - 1];
  const keys = (await s3list(`${release}${prefix}/`)).filter((k) => k.endsWith(".parquet"));
  return { release: release.split("/")[1], files: keys.map((k) => ({ url: `${OVERTURE}/${k}`, bbox: null })) };
}

const catalogs = new Map();
function overtureFiles(p) {
  if (!catalogs.has(p.stac)) {
    const job = stacFiles(p.stac).catch((e) => {
      console.warn("STAC catalog not usable, listing the bucket instead:", e);
      if (!p.allowAll) {
        throw new Error("The Overture STAC catalog could not be read, and without its file bboxes " +
          "this theme has too many files to open (" + (e.message || e) + ").");
      }
      return s3Files(p.s3);
    });
    catalogs.set(p.stac, job);
    job.catch(() => catalogs.delete(p.stac));
  }
  return catalogs.get(p.stac);
}

function view() {
  const b = map.getBounds();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  return {
    xmin: clamp(b.getWest(), -180, 180), xmax: clamp(b.getEast(), -180, 180),
    ymin: clamp(b.getSouth(), -90, 90), ymax: clamp(b.getNorth(), -90, 90),
  };
}

// The files a query opens: those whose bbox meets the view, or all of them
// when bboxes are not known.
async function sourceFiles() {
  const p = PRESETS[$("preset").value];
  if (p.stac) {
    const { release, files } = await overtureFiles(p);
    const v = view();
    const hit = files.filter((f) => !f.bbox ||
      (f.bbox[0] < v.xmax && f.bbox[2] > v.xmin && f.bbox[1] < v.ymax && f.bbox[3] > v.ymin));
    return { release, total: files.length, urls: hit.map((f) => f.url) };
  }
  const urls = expandUrls($("url").value);
  if (urls.length === 0) throw new Error("Give the URL of a GeoParquet file.");
  if (urls.length === 1) return { release: null, total: 1, urls };
  const files = await urlBboxes(urls);
  const v = view();
  const hit = files.filter((f) => !f.bbox ||
    (f.bbox[0] < v.xmax && f.bbox[2] > v.xmin && f.bbox[1] < v.ymax && f.bbox[3] > v.ymin));
  return { release: null, total: files.length, urls: hit.map((f) => f.url) };
}

// URLs from the box: several separated by spaces, and {00000..00123} in
// one of them for a numbered set (zero padded to the first number's width).
const MAX_FILES = 5000;
function expandUrls(text) {
  const out = [];
  for (const tok of text.trim().split(/\s+/).filter(Boolean)) {
    const m = tok.match(/\{(\d+)\.\.(\d+)\}/);
    if (!m) {
      out.push(tok);
      continue;
    }
    const [lo, hi] = [+m[1], +m[2]];
    const width = m[1].length;
    if (hi < lo || hi - lo + 1 > MAX_FILES) throw new Error(`${m[0]} is more than ${MAX_FILES} files`);
    for (let i = lo; i <= hi; i++) out.push(tok.replace(m[0], String(i).padStart(width, "0")));
  }
  if (out.length > MAX_FILES) throw new Error(`more than ${MAX_FILES} files`);
  return out;
}

// Each file's bbox, from the GeoParquet "geo" metadata in its footer. The
// first query over a set reads every footer once (the STAC catalog does
// this job for Overture); the bboxes are then kept in the browser, so
// later queries open only the files the view meets. A file without a bbox
// is always opened.
const indexes = new Map();
function urlBboxes(urls) {
  const key = `wxy-geo:${urls.length}:${urls[0]}:${urls[urls.length - 1]}`;
  if (!indexes.has(key)) {
    const job = (async () => {
      try {
        const kept = localStorage.getItem(key);
        if (kept) return JSON.parse(kept);
      } catch (e) { /* storage blocked */ }
      say(`Reading ${urls.length} file footers for their bboxes (once per set)...`);
      const bbox = new Map();
      try {
        const t = await conn.query(`SELECT file_name, decode(value) AS geo
          FROM parquet_kv_metadata([${urls.map(sqlString).join(", ")}]) WHERE decode(key) = 'geo'`);
        for (const row of t.toArray()) {
          const geo = JSON.parse(row.geo);
          const b = geo.columns?.[geo.primary_column]?.bbox;
          if (Array.isArray(b) && (b.length === 4 || b.length === 6)) {
            bbox.set(row.file_name, b.length === 4 ? b : [b[0], b[1], b[3], b[4]]);
          }
        }
      } catch (e) {
        console.warn("no file bboxes, opening every file:", e);
        return urls.map((url) => ({ url, bbox: null }));
      }
      const files = urls.map((url) => ({ url, bbox: bbox.get(url) || null }));
      try { localStorage.setItem(key, JSON.stringify(files)); } catch (e) { /* storage full or blocked */ }
      return files;
    })();
    indexes.set(key, job);
    job.catch(() => indexes.delete(key));
  }
  return indexes.get(key);
}

const sqlString = (s) => `'${s.replace(/'/g, "''")}'`;
function fill(sql, urls) {
  const v = view();
  const vals = {
    files: `[${urls.map(sqlString).join(", ")}]`,
    xmin: v.xmin.toFixed(6), xmax: v.xmax.toFixed(6), ymin: v.ymin.toFixed(6), ymax: v.ymax.toFixed(6),
  };
  return sql.replace(/\{(files|xmin|xmax|ymin|ymax)\}/g, (_, k) => vals[k]);
}

// Results
// Arrow decimals come back as four 32-bit words, least significant first.
function decimal(words, scale) {
  let n = 0n;
  for (let i = words.length - 1; i >= 0; i--) n = (n << 32n) | BigInt(words[i] >>> 0);
  if (words[words.length - 1] & 0x80000000) n -= 1n << BigInt(32 * words.length);
  const neg = n < 0n;
  const d = (neg ? -n : n).toString().padStart(scale + 1, "0");
  return (neg ? "-" : "") + (scale ? `${d.slice(0, -scale)}.${d.slice(-scale)}` : d);
}

function cell(v, type) {
  if (v === null || v === undefined) return "";
  if (type && type.scale !== undefined && v instanceof Uint32Array) return decimal(v, type.scale);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `${v.byteLength} bytes`;
  if (typeof v === "object") {
    const j = typeof v.toJSON === "function" ? v.toJSON() : v;
    return JSON.stringify(j, (_, x) => (typeof x === "bigint" ? x.toString() : x));
  }
  return String(v);
}

function show(table) {
  const n = Math.min(table.numRows, MAX_ROWS);
  const fields = table.schema.fields.map((f) => f.name);
  const gi = fields.indexOf("geometry");
  const cols = fields.map((name, i) => ({ name, i, vec: table.getChildAt(i) })).filter((c) => c.i !== gi);

  // Map: one feature per row with a geometry
  if (shapes) shapes.remove();
  byRow = new Map();
  picked = null;
  const features = [];
  let bad = 0;
  if (gi >= 0) {
    const g = table.getChildAt(gi);
    for (let r = 0; r < n; r++) {
      const v = g.get(r);
      if (!(v instanceof Uint8Array)) continue;
      try {
        const geometry = wkbToGeoJSON(v);
        if (geometry) features.push({ type: "Feature", geometry, properties: { row: r } });
      } catch (e) {
        bad += 1;
      }
    }
  }
  shapes = L.geoJSON({ type: "FeatureCollection", features }, {
    style: () => STYLE,
    pointToLayer: (f, ll) => L.circleMarker(ll, STYLE),
    onEachFeature: (f, layer) => {
      byRow.set(f.properties.row, layer);
      layer.on("click", () => pick(f.properties.row, false));
    },
  }).addTo(map);

  // Table
  const box = $("table");
  if (n === 0) {
    box.innerHTML = '<div class="empty">No rows.</div>';
    return { n, features: 0, bad, geometry: gi >= 0 };
  }
  const t = document.createElement("table");
  const head = t.createTHead().insertRow();
  for (const c of [{ name: "#" }, ...cols]) {
    const th = document.createElement("th");
    th.textContent = c.name;
    head.appendChild(th);
  }
  const body = t.createTBody();
  for (let r = 0; r < n; r++) {
    const tr = body.insertRow();
    tr.dataset.row = r;
    const idx = tr.insertCell();
    idx.textContent = r + 1;
    idx.className = "num";
    for (const c of cols) {
      const v = c.vec.get(r);
      const td = tr.insertCell();
      td.textContent = cell(v, c.vec.type);
      td.title = td.textContent;
      if (typeof v === "number" || typeof v === "bigint" || v instanceof Uint32Array) td.className = "num";
    }
  }
  body.addEventListener("click", (e) => {
    const tr = e.target.closest("tr");
    if (tr) pick(+tr.dataset.row, true);
  });
  box.replaceChildren(t);
  return { n, features: features.length, bad, geometry: gi >= 0 };
}

function pick(row, fromTable) {
  if (picked !== null) {
    byRow.get(picked)?.setStyle(STYLE);
    $("table").querySelector(`tr[data-row="${picked}"]`)?.classList.remove("on");
  }
  picked = row;
  const layer = byRow.get(row);
  const tr = $("table").querySelector(`tr[data-row="${row}"]`);
  tr?.classList.add("on");
  if (layer) {
    layer.setStyle(STYLE_ON);
    layer.bringToFront();
    if (fromTable) {
      const b = layer.getBounds ? layer.getBounds() : L.latLngBounds([layer.getLatLng()]);
      if (!map.getBounds().contains(b)) map.fitBounds(b, { maxZoom: Math.max(map.getZoom(), 14), padding: [20, 20] });
    }
  }
  if (!fromTable) tr?.scrollIntoView({ block: "nearest" });
}

// Running
let running = false;
let again = false;
async function run() {
  if (!conn) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  $("run").disabled = true;
  const t0 = performance.now();
  const r0 = io.requests;
  const b0 = io.bytes;
  try {
    say("Listing files...");
    // A query that does not use {files} runs as written.
    const sql = $("sql").value;
    let release = null;
    let opened = null;
    let urls = [];
    if (sql.includes("{files}")) {
      const src = await sourceFiles();
      if (src.urls.length === 0) throw new Error("No file of this source meets the view.");
      ({ release, urls } = src);
      opened = src.total > 1 ? `${urls.length} of ${src.total} files` : "1 file";
    }
    say(`Querying${opened ? ` ${opened}` : ""}${release ? ` (Overture ${release})` : ""}...`);
    const table = await conn.query(fill(sql, urls));
    const s = show(table);
    if (!/\{(xmin|xmax|ymin|ymax)\}/.test(sql) && s.features > 0) map.fitBounds(shapes.getBounds(), { padding: [20, 20] });
    const ms = performance.now() - t0;
    const mb = (io.bytes - b0) / 1e6;
    const lines = [
      `${table.numRows} row${table.numRows === 1 ? "" : "s"} in ${(ms / 1000).toFixed(1)} s` +
        (table.numRows > s.n ? ` (showing ${s.n})` : ""),
      `${io.requests - r0} HTTP requests, ${mb.toFixed(2)} MB read`,
    ];
    if (opened) lines.splice(1, 0, `${opened} opened` + (release ? ` (Overture ${release})` : ""));
    if (!s.geometry) lines.push("No geometry column, so nothing is drawn.");
    if (s.bad) lines.push(`${s.bad} geometries could not be decoded.`);
    say(lines.join("\n"));
  } catch (e) {
    say(String(e.message || e), true);
  } finally {
    running = false;
    $("run").disabled = false;
    if (again) {
      again = false;
      run();
    }
  }
}

// Controls
for (const [key, p] of Object.entries(PRESETS)) $("preset").add(new Option(p.label, key));
function choosePreset() {
  const p = PRESETS[$("preset").value];
  $("sql").value = p.sql;
  $("presethint").textContent = p.hint;
  $("urlrow").hidden = !!p.theme;
}
$("preset").addEventListener("change", choosePreset);
$("run").addEventListener("click", run);
map.on("moveend", () => { if ($("follow").checked) run(); });

// Deep links: ?preset=places&url=...&sql=...
const q = new URLSearchParams(location.search);
if (q.has("preset") && PRESETS[q.get("preset")]) $("preset").value = q.get("preset");
choosePreset();
if (q.has("url")) {
  $("preset").value = "url";
  choosePreset();
  $("url").value = q.get("url");
}
if (q.has("sql")) $("sql").value = q.get("sql");

start().then(() => {
  say("Ready. Pan the map, then Run.");
  $("run").disabled = false;
}, (e) => say(`DuckDB did not start: ${e.message || e}`, true));
