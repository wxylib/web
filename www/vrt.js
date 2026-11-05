// The VRT discovery page. Give it a VRT (a URL, a vrt:// string, or pasted
// XML) and it says what kind of VRT it is, what every part does, which
// sources it names and how, and, for a classic raster, what a read would
// touch: the source windows, where they land, the per-source operations,
// and the source tiles under them.
//
// The model and planner are vrt-model (wxylib/core) in WebAssembly; they
// read no bytes. This page does the reading: it fetches the document, any
// nested VRTs, and, when asked, each source's TIFF header (tiffhead.js).
// Multidimensional VRT is parsed by mdim-vrt.js and vector VRT here, until
// vrt-model models them too.

import init, { vrtClassic, vrtDsn, vrtLower, vrtPlan } from "./pkg/wxy_web.js";
import { parseMdimVrt, allArrays, vsiToUrl, coordValue, cfTime } from "./mdim-vrt.js";
import { readTiffHeader } from "./tiffhead.js";
import { FAMILIES, ELEMENTS, VRT_KEYS, PIXEL_FUNCTIONS, HANDLERS } from "./vrt-dict.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const fmt = (v) => (typeof v !== "number" ? String(v) : Math.abs(v) >= 1e15 ? (+v.toPrecision(10)).toExponential() : Number.isInteger(v) ? String(v) : String(+v.toPrecision(10)));
const kids = (el, tag) => Array.from(el.children).filter((c) => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0] ?? null;
const txt = (el, tag) => kid(el, tag)?.textContent.trim() ?? null;
const plural = (n, w) => `${n.toLocaleString("en")} ${w}${n === 1 ? "" : "s"}`;

const CORPUS = new URL("data/vrt-corpus/", location.href).href;
const TEACH = new URL("data/vrt-examples/", location.href).href;
const AUS = "https://data.source.coop/ausantarctic/";
const GHRSST = "https://data.source.coop/ausantarctic/ghrsst-mur-v2/";
const GHRSST_COG = GHRSST + "2024/01/01/20240101090000-JPL-L4_GHRSST-SSTfnd-MUR-GLOB-v02.0-fv04.1_analysed_sst.tif";

const EXAMPLES = [
  ["Corpus (checked against GDAL, byte for byte)", [
    ["c01 four tiles as one mosaic", CORPUS + "c01-mosaic.vrt"],
    ["c02 overlapping sources (the later one wins)", CORPUS + "c02-overlap.vrt"],
    ["c03 a source upsampled", CORPUS + "c03-upsample.vrt"],
    ["c04 a source downsampled", CORPUS + "c04-downsample.vrt"],
    ["c05 fractional windows", CORPUS + "c05-fractional.vrt"],
    ["c06 ComplexSource: nodata, scale and offset", CORPUS + "c06-complex.vrt"],
    ["c07 ComplexSource: lookup table", CORPUS + "c07-lut.vrt"],
    ["c08 bands from different files", CORPUS + "c08-bands.vrt"],
    ["c09 nested: a VRT of VRTs", CORPUS + "c09-nested.vrt"],
    ["v01 vrt:// choose and reorder bands", "vrt://" + CORPUS + "src/rgb.tif?bands=3,1"],
    ["v04 vrt:// window and resample", "vrt://" + CORPUS + "src/odd.tif?srcwin=3,3,21,21&outsize=14,14"],
  ]],
  ["Other forms", [
    ["Derived bands: pixel functions", TEACH + "derived.vrt"],
    ["Warped: reprojected on read", TEACH + "warped.vrt"],
    ["Source name forms in one VRT", TEACH + "names.vrt"],
    ["Multidimensional: tiles stacked in time", TEACH + "mdim-stack.vrt"],
    ["Vector: points from CSV columns, and a union", TEACH + "vector.vrt"],
  ]],
  ["Published data (live)", [
    ["GHRSST MUR, 2002 to now: one mdim VRT of COGs (16.6 MB)", GHRSST + "ghrsst-mur-v2.vrt"],
    ["REMA 2 m mosaic of Antarctica: 5,800 COG tiles and five overviews", "https://raw.githubusercontent.com/mdsumner/rema-ovr/main/REMA-2m_dem_ovr.vrt"],
    ["Copernicus DEM 30 m, global (OpenTopography; needs CORS on their side)", "https://opentopography.s3.sdsc.edu/raster/COP30/COP30_hh.vrt"],
    ["vrt:// over one GHRSST COG: Tasmania at a tenth", "vrt:///vsicurl/" + GHRSST_COG + "?srcwin=32300,12900,1200,1100&outsize=10%,10%"],
  ]],
  ["Antarctic and ocean collections (live, source.coop)", [
    ["Bluelink BRAN daily temperature: 403 monthly netCDF files, 4D with depth", AUS + "ausantarctic-scratch/bluelink/bluelink-daily-temp/mdim.vrt"],
    ["OISST v2.1 daily: 16,482 netCDF files, four arrays (24 MB)", AUS + "ausantarctic-scratch/oisst/oisst-v2.1-daily/mdim.vrt"],
    ["AMSR2 sea ice south: daily netCDF with SourceTranspose, and gaps", AUS + "ausantarctic-scratch/seaice/asi-amsr2-v5.4-daily-south/mdim.vrt"],
    ["ESA CCI ocean colour monthly: COGs with overview-level arrays", AUS + "ausantarctic-scratch/oceancolour/esacci-oc-v6.0-monthly-chlor_a/mdim.vrt"],
    ["GEBCO 2024: one COG as an array, with eight overview levels", AUS + "gebco/virtual/gebco-2024/mdim.vrt"],
    ["IBCSO v2: bed, ice surface and two id grids, each with overview levels", AUS + "ibcso/virtual/ibcso-v2/mdim.vrt"],
  ]],
];

const SOURCE_KINDS = ["SimpleSource", "ComplexSource", "AveragedSource", "KernelFilteredSource", "NoDataFromMaskSource", "ArraySource"];

let state = null;

function status(msg, error = false) {
  const s = $("status");
  s.textContent = msg;
  s.className = error ? "error" : "";
}

// ---------------------------------------------------------------- names

// A fetchable URL for a source name, or null (a handler the browser has
// no route to, or a driver prefix).
function urlOf(name, base) {
  const u = urlOf0(name, base);
  // github.com/o/r/raw/... redirects without CORS headers; its raw host has them
  const m = u && u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/raw\/(.*)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}

function urlOf0(name, base) {
  const s = String(name).trim();
  if (/^https?:\/\//.test(s)) return s;
  if (s.startsWith("/vsi")) return vsiToUrl(s, base, false);
  if (/^[A-Za-z][A-Za-z0-9_]*:/.test(s)) return null; // driver prefix, other scheme
  if (s.startsWith("/")) return null; // a local absolute path
  return base ? new URL(s, base).href : null;
}

// The forms a relative source name can take as a key: joined as the
// planner joins it (base + "/" + name), and as a normalised URL.
function keysOf(name, relative, base) {
  if (!relative) return [name];
  const raw = (base || "").replace(/\/$/, "") + "/" + name;
  const out = [raw];
  try { out.push(new URL(name, base || location.href).href); } catch {}
  return out;
}

function norm(name) {
  try { return /^https?:/.test(name) ? new URL(name).href : name; } catch { return name; }
}

function baseOf(url) {
  return url ? url.replace(/[^/]*$/, "") : "";
}

// A parsed source name as nested chips, outermost first.
function dsnChips(d) {
  const chip = (cls, label, title) => `<span class="chip ${cls}" title="${esc(title)}">${esc(label)}</span>`;
  switch (d.kind) {
    case "vsi": {
      const head = chip("vsi", "/" + d.handler + "/", HANDLERS[d.handler] ?? "A virtual file system handler.");
      const inner = d.inner ? `<span class="nest">{ ${dsnChips(d.inner)} }</span>` : "";
      const path = d.path ? chip("path", d.path, d.archive ? "The member inside the archive." : "The path the handler reads.") : "";
      return head + inner + path;
    }
    case "driver":
      return chip("drv", d.prefix + ":", `Driver prefix: open with the ${d.prefix} driver.`) +
        dsnChips(d.source) + (d.subdataset ? chip("sub", ":" + d.subdataset, "The subdataset (variable) inside the file.") : "");
    case "vrtstring":
      return chip("vrts", "vrt://", "A vrt:// string: the source, then translate options.") + dsnChips(d.source) +
        d.options.map(([k, v]) => chip("opt", `${k}=${v}`, VRT_KEYS[k] ? `${VRT_KEYS[k][1]} (${VRT_KEYS[k][0]}): ${VRT_KEYS[k][2]}` : "Not a key the reference library knows.")).join("");
    case "inline":
      return chip("vrts", "inline VRT", "A whole VRT document written in place of a name.");
    case "url":
      return chip("url", d.url, "A URL.");
    default:
      return chip(d.virtual ? "vrtf" : "path", d.path, d.virtual ? "Another VRT file: read through, recursively." : "A path.");
  }
}

function dsnKind(d) {
  if (d.kind === "vsi") return d.archive ? "archive" : d.handler;
  if (d.kind === "driver") return "driver " + d.prefix;
  if (d.kind === "vrtstring") return "vrt://";
  if (d.kind === "inline") return "inline VRT";
  if (d.virtual) return "nested VRT";
  return d.kind;
}

// ---------------------------------------------------------------- loading

async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.text();
}

async function load(input, pasted = null) {
  const t0 = performance.now();
  $("out").hidden = true;
  state = { input, nested: new Map(), headers: new Map(), base: "" };
  try {
    if (pasted != null) {
      state.text = pasted;
      state.base = baseOf(new URL(".", location.href).href);
      state.source = "pasted text";
    } else if (input.startsWith("vrt://")) {
      await loadVrtString(input);
    } else {
      const url = urlOf(input, location.href) ?? input;
      status(`Fetching ${url} ...`);
      state.text = await fetchText(url);
      state.url = url;
      state.base = baseOf(url);
      state.source = url;
      try { history.replaceState(null, "", "?src=" + encodeURIComponent(input)); } catch {}
    }
    if (state.text != null) {
      status("Parsing ...");
      await new Promise((r) => setTimeout(r, 0));
      analyse();
    }
    render();
    const ms = Math.round(performance.now() - t0);
    status(`${state.family ? FAMILIES[state.family].title : "Done"}. ${plural(state.text?.length ?? 0, "character")} read in ${ms} ms.`);
  } catch (e) {
    console.error(e);
    status(String(e.message ?? e), true);
  }
}

// A vrt:// string: parse it, read the source's header, lower it to the
// classic VRT translate would write, and explore that.
async function loadVrtString(input) {
  try { history.replaceState(null, "", "?src=" + encodeURIComponent(input)); } catch {}
  const d = JSON.parse(vrtDsn(input));
  state.vrtstring = d;
  state.source = input;
  const name = d.source.text;
  const url = urlOf(name, location.href);
  state.vrtSourceUrl = url;
  if (!url) {
    state.lowerError = `The source ${name} has no route from a browser, so its header (size, bands, type) cannot be read to lower the string.`;
    return;
  }
  status(`Reading the header of ${url} ...`);
  let h;
  try {
    h = await readTiffHeader(url);
  } catch (e) {
    state.lowerError = `Could not read a TIFF header from ${url}: ${e.message}. Lowering needs the source's size, bands and type.`;
    return;
  }
  state.headers.set(name, h);
  const info = {
    x_size: h.width,
    y_size: h.height,
    band_types: Array(h.bands).fill(h.dataType),
    geotransform: h.geotransform,
    srs: h.epsg ? `EPSG:${h.epsg}` : null,
    nodata: Array(h.bands).fill(h.nodata),
  };
  const r = JSON.parse(vrtLower(input, JSON.stringify(info)));
  if (!r.ok) {
    state.lowerError = r.error;
    return;
  }
  state.text = r.xml;
  state.lowered = true;
  state.base = "";
}

// ---------------------------------------------------------------- analysis

function analyse() {
  const text = state.text.trim();
  if (text.startsWith("{")) {
    state.family = "unknown";
    state.note = "This is JSON. A GDALG file (a pipeline of the reference library's command line, with a schema) is a neighbour of VRT; this page reads XML VRT only.";
    return;
  }
  const doc = new DOMParser().parseFromString(text, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("Not valid XML: " + err.textContent.slice(0, 200));
  state.doc = doc;
  const root = doc.documentElement;
  // element census: every element name, how many, under which parents
  const census = new Map();
  for (const el of doc.getElementsByTagName("*")) {
    const c = census.get(el.tagName) ?? { n: 0, parents: new Set() };
    c.n += 1;
    if (el.parentElement) c.parents.add(el.parentElement.tagName);
    census.set(el.tagName, c);
  }
  state.census = census;
  if (root.tagName === "OGRVRTDataSource") {
    state.family = "vector";
    state.vector = parseVector(root);
  } else if (root.tagName === "GDALTileIndexDataset") {
    state.family = "gti";
  } else if (root.tagName === "VRTDataset" && kid(root, "Group")) {
    state.family = "mdim";
    state.mdim = parseMdimVrt(text, state.base || location.href);
  } else if (root.tagName === "VRTDataset") {
    const sub = root.getAttribute("subClass");
    state.family = sub === "VRTWarpedDataset" ? "warped" : sub === "VRTPansharpenedDataset" ? "pansharpened"
      : sub === "VRTProcessedDataset" ? "processed"
      : kids(root, "VRTRasterBand").some((b) => b.getAttribute("subClass") === "VRTDerivedRasterBand") ? "derived" : "classic";
    const r = JSON.parse(vrtClassic(text));
    if (r.ok) state.classic = r.dataset;
    else state.classicError = r.error;
  } else {
    state.family = "unknown";
  }
  state.capabilities = capabilities();
}

// What the document does, as short labelled facts.
function capabilities() {
  const c = state.census;
  const has = (n) => c.has(n);
  const n = (k) => c.get(k)?.n ?? 0;
  const out = [];
  const add = (label, detail) => out.push([label, detail]);
  const root = state.doc.documentElement;
  if (state.lowered) add("vrt:// lowered", "The string was turned into the classic VRT a translate call would write.");
  if (["classic", "derived", "warped"].includes(state.family) && state.classic) {
    const ds = state.classic;
    const srcs = ds.bands.flatMap((b) => b.sources);
    const files = new Set(srcs.map((s) => s.filename.text));
    add(`${ds.x_size} x ${ds.y_size}`, `${plural(ds.bands.length, "band")}` + (srcs.length ? `, ${plural(srcs.length, "source")} over ${plural(files.size, "file")}.` : state.family === "warped" ? "; the pixels come from the warp." : "."));
    const placed = srcs.filter((s) => s.dst_rect && (s.dst_rect[0] || s.dst_rect[1] || s.dst_rect[2] !== ds.x_size || s.dst_rect[3] !== ds.y_size));
    if (placed.length && files.size > 1) add("mosaic", "Sources are placed side by side by their DstRect.");
    const resampled = srcs.filter((s) => s.src_rect && s.dst_rect && (Math.abs(s.src_rect[2] - s.dst_rect[2]) > 1e-9 || Math.abs(s.src_rect[3] - s.dst_rect[3]) > 1e-9));
    if (resampled.length) add("implicit resampling", `${plural(resampled.length, "source")} with SrcRect and DstRect of different sizes: read nearest (or as the resampling attribute says) without anyone asking. Design m11 calls this a quiet operation.`);
    const frac = srcs.filter((s) => [s.src_rect, s.dst_rect].some((r) => r && r.some((v) => !Number.isInteger(v))));
    if (frac.length) add("fractional windows", `${plural(frac.length, "source")} with fractional SrcRect or DstRect: the reference library's rounding decides which pixels are taken.`);
    if (has("NODATA") || has("UseMaskBand")) add("source nodata", "Some source values are skipped, so what is under them shows through.");
    if (has("ScaleRatio") || has("ScaleOffset") || has("Exponent")) add("value scaling", "Source values are rescaled on read.");
    if (has("LUT")) add("lookup table", "Source values are mapped through a piecewise-linear table.");
    if (srcs.some((s) => s.filename.virtual)) add("nested VRT", "Some sources are VRTs themselves: a read goes through them.");
    const kinds = new Set(srcs.map((s) => dsnKind(s.filename)));
    for (const k of kinds) {
      if (["path", "url", "nested VRT"].includes(k)) continue;
      const say = k === "archive" ? "A member of an archive (/vsizip/ and friends): the reader opens the archive, then the file inside it."
        : k === "vrt://" ? "A source given as a vrt:// string: a translate call written as a name, itself a VRT."
        : k.startsWith("driver ") ? `A driver prefix: the ${k.slice(7)} driver opens the file and picks a subdataset.`
        : k === "inline VRT" ? "A whole VRT written in place of a name."
        : HANDLERS[k] ?? "A virtual file system handler.";
      add(`source: ${k}`, say);
    }
    if (srcs.some((s) => s.relative)) add("relative names", "Some sources are relative to the VRT's own location.");
    if (srcs.some((s) => s.properties)) add("declared source sizes", "SourceProperties gives sizes and types, so a reader need not open every source to plan.");
    else if (srcs.length) add("undeclared source sizes", "No SourceProperties: a reader opens each source to learn its size.");
  }
  const derived = kids(root, "VRTRasterBand").filter((b) => b.getAttribute("subClass") === "VRTDerivedRasterBand");
  for (const b of derived) {
    const f = txt(b, "PixelFunctionType");
    const lang = txt(b, "PixelFunctionLanguage");
    const info = PIXEL_FUNCTIONS[f];
    add(`pixel function: ${f}`, lang ? `${lang} code in the document.` : info ? `${info[3]} Inputs: ${info[0]}.` : "Not a built-in name: registered by the application.");
  }
  if (state.family === "warped") {
    const opt = kid(root, "GDALWarpOptions");
    add("warp", `Resampling ${txt(opt, "ResampleAlg") ?? "default"}, from ${txt(opt, "SourceDataset") ?? "?"}.`);
  }
  if (has("MaskBand")) add("mask band", "A mask is described in the document.");
  if (has("OverviewList") || has("Overview")) add("overviews", "Overviews are named or built virtually.");
  if (has("ColorTable")) add("colour table", "A palette for display.");
  if (has("GDALRasterAttributeTable")) add("attribute table", "Classes with attributes.");
  if (has("Metadata")) add("metadata", `${plural(n("MDI"), "item")}.`);
  if (state.family === "mdim") {
    const arrays = allArrays(state.mdim);
    const data = arrays.filter((a) => a.sources?.length);
    const srcs = data.flatMap((a) => a.sources);
    add(`${plural(arrays.length, "array")}`, `${plural(data.length, "array")} filled from ${plural(srcs.length, "source")}.`);
    const noCount = srcs.filter((s) => s.kind === "Source" && !s.srcCount);
    if (noCount.length) add("sources without a slab count", `${plural(noCount.length, "source")} have no SourceSlab count, so a reader opens each one to learn its shape: slow for long stacks.`);
    if (srcs.some((s) => s.transpose)) add("transpose", "Some sources reorder or add axes (SourceTranspose -1 stacks a 2D band as one step).");
    if (has("DerivedArray")) add("derived arrays", "Arrays computed by steps from other arrays.");
    if (has("RegularlySpacedValues")) add("regular coordinates", "Coordinates from start and increment.");
  }
  if (state.family === "vector") {
    const L = state.vector.layers;
    add(plural(L.length, "layer"), L.map((l) => `${l.name} (${l.kind})`).join(", "));
    if (has("SrcSQL")) add("SQL on the source", "A layer is the result of a query.");
    const enc = new Set(L.flatMap((l) => l.geoms.map((g) => g.encoding)));
    for (const e of enc) if (e && e !== "Direct") add(`geometry from ${e}`, "Geometry is built from attribute columns.");
    if (has("OGRVRTUnionLayer")) add("union layer", "Layers combined into one.");
    if (has("OGRVRTWarpedLayer")) add("reprojected layer", "A layer warped to another CRS.");
  }
  return out;
}

function parseVector(root) {
  const layer = (el) => {
    const ds = kid(el, "SrcDataSource");
    const geoms = kids(el, "GeometryField").map((g) => ({
      name: g.getAttribute("name"),
      encoding: g.getAttribute("encoding") ?? "Direct",
      field: g.getAttribute("field"),
      x: g.getAttribute("x"), y: g.getAttribute("y"), z: g.getAttribute("z"),
      type: txt(g, "GeometryType"),
      srs: txt(g, "SRS"),
    }));
    if (kid(el, "GeometryType") || kid(el, "LayerSRS")) geoms.unshift({ name: "", encoding: kid(el, "GeometryField") ? null : "Direct", type: txt(el, "GeometryType"), srs: txt(el, "LayerSRS") });
    return {
      kind: el.tagName.replace("OGRVRT", ""),
      name: el.getAttribute("name") ?? (el.tagName === "OGRVRTWarpedLayer" ? [...kids(el, "OGRVRTLayer"), ...kids(el, "OGRVRTUnionLayer")][0]?.getAttribute("name") : null),
      source: ds ? { name: ds.textContent.trim(), relative: ds.getAttribute("relativeToVRT") === "1", shared: ds.getAttribute("shared") } : null,
      srcLayer: txt(el, "SrcLayer"),
      sql: txt(el, "SrcSQL"),
      dialect: kid(el, "SrcSQL")?.getAttribute("dialect"),
      fid: txt(el, "FID"),
      geoms,
      fields: kids(el, "Field").map((f) => ({ name: f.getAttribute("name"), type: f.getAttribute("type") ?? "String", src: f.getAttribute("src") })),
      region: txt(el, "SrcRegion"),
      children: [...kids(el, "OGRVRTLayer"), ...kids(el, "OGRVRTUnionLayer"), ...kids(el, "OGRVRTWarpedLayer")].map(layer),
      srcSRS: txt(el, "SrcSRS"),
      targetSRS: txt(el, "TargetSRS"),
      fieldStrategy: txt(el, "FieldStrategy"),
    };
  };
  return { layers: [...kids(root, "OGRVRTLayer"), ...kids(root, "OGRVRTUnionLayer"), ...kids(root, "OGRVRTWarpedLayer")].map(layer) };
}

// ---------------------------------------------------------------- rendering

function render() {
  $("out").hidden = false;
  const fam = FAMILIES[state.family ?? (state.vrtstring ? "vrtstring" : "unknown")];
  $("family").innerHTML = `<div class="fam"><b>${esc(fam.title)}</b><p>${esc(fam.text)}</p>` +
    (state.note ? `<p>${esc(state.note)}</p>` : "") + `<p class="hint">From ${esc(state.source)}</p></div>`;
  $("caps").innerHTML = (state.capabilities ?? []).map(([l, d]) => `<div class="cap"><b>${esc(l)}</b> <span>${esc(d)}</span></div>`).join("");
  renderVrtString();
  renderClassic();
  renderMdim();
  wireMdim();
  renderVector();
  renderCensus();
  renderTree();
  renderText();
}

function section(id, show) {
  $(id).hidden = !show;
  return show;
}

function renderVrtString() {
  if (!section("s-vrtstring", !!state.vrtstring)) return;
  const d = state.vrtstring;
  const since = d.options.map(([k]) => VRT_KEYS[k]?.[0]).filter(Boolean);
  const newest = since.sort((a, b) => a.localeCompare(b, "en", { numeric: true })).pop();
  $("vrtstring").innerHTML =
    `<p class="name">${dsnChips(d)}</p>` +
    `<table><tr><th>key</th><th>value</th><th>translate flag</th><th>since</th><th>lowered by vrt-model</th><th>what it does</th></tr>` +
    d.options.map(([k, v]) => {
      const info = VRT_KEYS[k];
      return `<tr><td><code>${esc(k)}</code></td><td><code>${esc(v)}</code></td><td>${esc(info?.[1] ?? "unknown key")}</td>` +
        `<td>${esc(info?.[0] ?? "")}</td><td>${d.lowered.includes(k) ? "yes" : "not yet"}</td><td>${esc(info?.[2] ?? "")}</td></tr>`;
    }).join("") + `</table>` +
    `<p class="hint">The source is <code>${esc(d.source.text)}</code>. ` +
    (newest ? `The newest key here needs release ${esc(newest)} or later of the reference library to read this string. ` : "") +
    `The reference library splits a vrt:// string at its first <code>?</code>, so a vrt:// string cannot name another one; vrt-model splits at the last, which nests.</p>` +
    (state.lowerError ? `<p class="warn">${esc(state.lowerError)}</p>` : "") +
    (state.lowered ? `<p>Lowered below: the classic VRT this string stands for, read from the source header (${esc(state.vrtSourceUrl)}).</p>` : "");
}

const PALETTE = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac"];

function renderClassic() {
  const show = !!state.classic || !!state.classicError;
  if (!section("s-classic", show)) return;
  if (state.classicError) {
    $("grid").innerHTML = `<p class="warn">vrt-model could not read this document: ${esc(state.classicError)}</p>`;
    $("bandsel").innerHTML = "";
    return;
  }
  const ds = state.classic;
  const gt = ds.geotransform;
  const ext = gt ? [gt[0], gt[3] + ds.y_size * gt[5], gt[0] + ds.x_size * gt[1], gt[3]] : null;
  $("grid").innerHTML = `<table>
    <tr><th>size</th><td>${ds.x_size} x ${ds.y_size} pixels, ${plural(ds.bands.length, "band")}</td></tr>
    <tr><th>geotransform</th><td>${gt ? gt.map(fmt).join(", ") : "none"}</td></tr>
    ${ext ? `<tr><th>extent</th><td>x ${fmt(ext[0])} to ${fmt(ext[2])}, y ${fmt(ext[1])} to ${fmt(ext[3])}</td></tr>` : ""}
    <tr><th>CRS</th><td>${ds.srs ? esc(ds.srs.length > 120 ? ds.srs.slice(0, 120) + " ..." : ds.srs) : "none"}</td></tr>
    ${ds.sub_class ? `<tr><th>subClass</th><td>${esc(ds.sub_class)}</td></tr>` : ""}
    <tr><th>model</th><td>${ds.round_trip ? "vrt-model reads this document and writes back the same model" : "write-back differs"}; ${ds.unknown.length ? `kept without interpreting: ${esc([...new Set(ds.unknown)].join(", "))}` : "every element interpreted"}</td></tr>
  </table>`;
  const root = state.doc.documentElement;
  const wo = kid(root, "GDALWarpOptions");
  if (wo) {
    const chain = [];
    let t = kid(wo, "Transformer");
    while (t && t.firstElementChild) {
      t = t.firstElementChild;
      if (/Transformer$/.test(t.tagName)) chain.push(t.tagName);
      t = kid(t, "BaseTransformer") ?? kid(t, "ReprojectTransformer") ?? t;
      if (!t.firstElementChild || chain.length > 6) break;
    }
    const opts = kids(wo, "Option").map((o) => `${o.getAttribute("name")}=${o.textContent}`);
    $("grid").innerHTML += `<h3>The warp</h3><table>
      <tr><th>source</th><td>${dsnChips(JSON.parse(vrtDsn(txt(wo, "SourceDataset") ?? "")))}</td></tr>
      <tr><th>resampling</th><td>${esc(txt(wo, "ResampleAlg") ?? "")}</td></tr>
      <tr><th>working type</th><td>${esc(txt(wo, "WorkingDataType") ?? "")}</td></tr>
      <tr><th>transformer</th><td>${esc(chain.join(" over ") || "")}${state.doc.querySelector("MaxError") ? ` (approximated within ${esc(state.doc.querySelector("MaxError").textContent)} pixels)` : ""}</td></tr>
      <tr><th>options</th><td>${esc(opts.join(", "))}</td></tr></table>`;
  }
  // bands
  const bandEls = kids(root, "VRTRasterBand");
  $("bands").innerHTML = `<table><tr><th>band</th><th>type</th><th>nodata</th><th>colour</th><th>sources</th><th>computed by</th></tr>` +
    ds.bands.map((b, i) => {
      const el = bandEls[i];
      const f = el && txt(el, "PixelFunctionType");
      const args = el && kid(el, "PixelFunctionArguments");
      const pf = f ? `<code>${esc(f)}</code>${args ? " " + Array.from(args.attributes).map((a) => `<code>${esc(a.name)}=${esc(a.value)}</code>`).join(" ") : ""}<br><span class="hint">${esc(PIXEL_FUNCTIONS[f]?.[3] ?? (txt(el, "PixelFunctionLanguage") ? "Python code in the document" : "not a built-in"))}</span>` : (b.sub_class ? esc(b.sub_class) : "its sources, in order");
      return `<tr><td>${b.band ?? i + 1}</td><td>${esc(b.data_type)}</td><td>${esc(b.nodata ?? "")}</td><td>${esc(el ? txt(el, "ColorInterp") ?? "" : "")}</td><td>${b.sources.length}</td><td>${pf}</td></tr>`;
    }).join("") + "</table>";
  const ovr = bandEls.flatMap((el, i) => kids(el, "Overview").map((o) => [i + 1, txt(o, "SourceFilename"), txt(o, "SourceBand"), kid(o, "SourceFilename")?.getAttribute("relativeToVRT") === "1"]));
  if (ovr.length) {
    $("bands").innerHTML += `<h3>Overviews named in the document</h3><p class="hint">A reader asked for a reduced read takes the overview nearest the reduction instead of the sources (an overview here is its own dataset, often another VRT).</p>` +
      `<table><tr><th>band</th><th>overview</th><th>band in it</th></tr>` + ovr.map(([b, f, sb, rel]) => {
        const d = JSON.parse(vrtDsn(f ?? ""));
        const u = d.virtual ? urlOf(rel ? new URL(f, state.base || location.href).href : f, state.base) : null;
        return `<tr><td>${b}</td><td class="name">${dsnChips(d)}${u ? ` <a href="?src=${encodeURIComponent(u)}">explore</a>` : ""}</td><td>${esc(sb ?? "")}</td></tr>`;
      }).join("") + "</table>";
  }
  const sel = $("bandsel");
  sel.innerHTML = ds.bands.map((b, i) => `<option value="${i + 1}">band ${i + 1}</option>`).join("");
  sel.value = "1";
  $("pband").innerHTML = sel.innerHTML;
  $("rx").value = 0; $("ry").value = 0; $("rw").value = ds.x_size; $("rh").value = ds.y_size;
  const scale = Math.min(1, 512 / Math.max(ds.x_size, ds.y_size));
  $("bx").value = Math.max(1, Math.round(ds.x_size * scale)); $("by").value = Math.max(1, Math.round(ds.y_size * scale));
  renderSources();
  fetchNested().then(() => { renderSources(); runPlan(); });
}

function sourceRows(band) {
  const b = state.classic.bands[band - 1];
  return b ? b.sources : [];
}

function renderSources() {
  if (!state.classic) return;
  const band = Number($("bandsel").value || 1);
  const srcs = sourceRows(band);
  const files = [...new Set(srcs.map((s) => s.filename.text))];
  const colour = (s) => PALETTE[files.indexOf(s.filename.text) % PALETTE.length];
  const shown = srcs.slice(0, 2000);
  $("sources").innerHTML = `<table><tr><th>#</th><th>kind</th><th>name</th><th>band</th><th>SrcRect</th><th>DstRect</th><th>operations</th><th>header</th></tr>` +
    shown.map((s, i) => {
      const ops = [];
      if (s.nodata != null) ops.push(`skip ${esc(s.nodata)}`);
      if (s.scale_ratio != null || s.scale_offset != null) ops.push(`x ${fmt(s.scale_ratio ?? 1)} + ${fmt(s.scale_offset ?? 0)}`);
      if (s.lut) ops.push(`LUT ${s.lut.map((p) => p.map(fmt).join(":")).join(", ")}`);
      if (s.resampling) ops.push(`resampling ${esc(s.resampling)}`);
      for (const e of s.extra) ops.push(esc(e));
      const name = s.relative ? new URL(s.filename.text, state.base || location.href).href : s.filename.text;
      const h = state.headers.get(name) ?? state.headers.get(s.filename.text);
      const nested = state.nested.get(name);
      const hdr = h ? `${h.width} x ${h.height} ${h.dataType}, ${h.layout} ${h.block.join("x")}` : nested ? `VRT ${nested.ds ? nested.ds.x_size + " x " + nested.ds.y_size : ""}` : "";
      const explore = s.filename.virtual && urlOf(name, state.base) ? ` <a href="?src=${encodeURIComponent(urlOf(name, state.base))}">explore</a>` : "";
      return `<tr data-i="${i}" class="pick${i >= 50 ? " fold" : ""}"><td><span class="sw" style="background:${colour(s)}"></span>${i + 1}</td><td>${esc(s.kind)}</td>` +
        `<td class="name">${dsnChips(s.filename)}${s.relative ? ' <span class="hint">relative to the VRT</span>' : ""}${explore}</td>` +
        `<td>${esc(s.source_band)}</td><td>${s.src_rect ? s.src_rect.map(fmt).join(", ") : "whole"}</td><td>${s.dst_rect ? s.dst_rect.map(fmt).join(", ") : "whole"}</td>` +
        `<td>${ops.join("<br>")}</td><td>${esc(hdr)}</td></tr>`;
    }).join("") + "</table>" + foldNote(shown.length, srcs.length, "source");
  wireFold($("sources"));
  for (const tr of $("sources").querySelectorAll("tr.pick")) tr.onclick = () => pickSource(band, Number(tr.dataset.i));
  $("picked").innerHTML = "";
  state.picked = null;
  drawLayout(band, colour);
  drawSourceSpace(band, 0);
}

// Long tables show 50 rows and a button for the rest (up to 2000).
function foldNote(shown, total, what) {
  if (total <= 50) return "";
  return `<p class="hint">50 of ${plural(total, what)} shown. <button class="unfold">Show ${(shown - 50).toLocaleString("en")} more</button>` +
    (total > shown ? ` The table stops at ${shown.toLocaleString("en")}; click the layout to pick any ${what}.` : "") + `</p>`;
}

function wireFold(box) {
  const b = box.querySelector("button.unfold");
  if (b) b.onclick = () => { for (const r of box.querySelectorAll("tr.fold")) r.classList.remove("fold"); b.parentElement.remove(); };
}

// Every nested VRT a source names, fetched (up to 40), for planning and the
// sources table.
async function fetchNested() {
  const todo = [];
  const visit = (ds, base) => {
    for (const b of ds.bands) for (const s of b.sources) {
      if (!s.filename.virtual || s.filename.kind === "vrtstring" || s.filename.kind === "inline") continue;
      const keys = keysOf(s.filename.text, s.relative, base);
      const name = keys[keys.length - 1];
      if (!state.nested.has(name)) todo.push([name, urlOf(name, base), keys]);
    }
  };
  visit(state.classic, state.base);
  let n = 0;
  while (todo.length && n < 40) {
    const [name, url, keys] = todo.shift();
    if (state.nested.has(name) || !url) continue;
    n += 1;
    try {
      const text = await fetchText(url);
      const r = JSON.parse(vrtClassic(text));
      state.nested.set(name, { text, keys, ds: r.ok ? r.dataset : null });
      if (r.ok) visit(r.dataset, baseOf(url));
    } catch (e) {
      state.nested.set(name, { error: e.message });
    }
  }
}

// The VRT's own pixel grid with each source's DstRect, and the last plan's
// output regions.
function drawLayout(band, colour) {
  const ds = state.classic;
  const srcs = sourceRows(band);
  const W = 520, pad = 24;
  const k = (W - 2 * pad) / Math.max(ds.x_size, ds.y_size);
  const w = ds.x_size * k, h = ds.y_size * k;
  const svg = [`<svg viewBox="0 0 ${w + 2 * pad} ${h + 2 * pad + 18}" class="fig pickable" role="img" aria-label="Layout of sources in the VRT grid">`];
  svg.push(`<rect x="${pad}" y="${pad}" width="${w}" height="${h}" class="frame"/>`);
  const rectOf = (s) => s.dst_rect ?? [0, 0, ds.x_size, ds.y_size];
  if (srcs.length <= 1500) {
    srcs.forEach((s, i) => {
      const r = rectOf(s);
      svg.push(`<rect x="${pad + r[0] * k}" y="${pad + r[1] * k}" width="${Math.max(0.5, r[2] * k)}" height="${Math.max(0.5, r[3] * k)}" fill="${colour(s)}" fill-opacity="0.35" stroke="${colour(s)}" ${s.filename.virtual ? 'stroke-dasharray="4 3"' : ""}><title>source ${i + 1}: ${esc(s.filename.text)}\nDstRect ${r.map(fmt).join(", ")}</title></rect>`);
      if (srcs.length <= 40) svg.push(`<text x="${pad + (r[0] + r[2] / 2) * k}" y="${pad + (r[1] + r[3] / 2) * k + 4}" class="lbl">${i + 1}</text>`);
    });
  } else {
    // many sources: one path per colour, every source drawn
    const paths = new Map();
    for (const s of srcs) {
      const r = rectOf(s);
      const c = colour(s);
      const d = paths.get(c) ?? [];
      const x = (pad + r[0] * k).toFixed(2), y = (pad + r[1] * k).toFixed(2);
      const rw = Math.max(0.4, r[2] * k).toFixed(2), rh = Math.max(0.4, r[3] * k).toFixed(2);
      d.push(`M${x} ${y}h${rw}v${rh}h-${rw}z`);
      paths.set(c, d);
    }
    for (const [c, d] of paths) svg.push(`<path d="${d.join("")}" fill="${c}" fill-opacity="0.35" stroke="${c}" stroke-width="0.3"/>`);
  }
  const plan = state.plan;
  if (plan && plan.band === band) {
    const [rx, ry, rw, rh] = plan.req;
    svg.push(`<rect x="${pad + rx * k}" y="${pad + ry * k}" width="${rw * k}" height="${rh * k}" class="req"><title>the request window</title></rect>`);
  }
  if (state.picked?.band === band) {
    const r = rectOf(srcs[state.picked.i]);
    svg.push(`<rect x="${pad + r[0] * k}" y="${pad + r[1] * k}" width="${Math.max(2, r[2] * k)}" height="${Math.max(2, r[3] * k)}" class="pick"/>`);
  }
  svg.push(`<text x="${pad}" y="${pad - 8}" class="ax">0, 0</text><text x="${pad + w}" y="${pad + h + 14}" class="ax" text-anchor="end">${ds.x_size}, ${ds.y_size}</text>`);
  svg.push(`<text x="${pad}" y="${pad + h + 30}" class="ax">${plural(srcs.length, "source")} in VRT pixels; click one to see it; black outline: the request</text></svg>`);
  $("layout").innerHTML = svg.join("");
  // click: the source drawn last under the point is the one that wins there
  $("layout").firstElementChild.onclick = (e) => {
    const el = e.currentTarget;
    const pt = el.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const q = pt.matrixTransform(el.getScreenCTM().inverse());
    const px = (q.x - pad) / k, py = (q.y - pad) / k;
    for (let i = srcs.length - 1; i >= 0; i--) {
      const r = rectOf(srcs[i]);
      if (px >= r[0] && px < r[0] + r[2] && py >= r[1] && py < r[1] + r[3]) {
        pickSource(band, i);
        return;
      }
    }
  };
}

function pickSource(band, i) {
  state.picked = { band, i };
  const s = sourceRows(band)[i];
  const files = [...new Set(sourceRows(band).map((x) => x.filename.text))];
  drawLayout(band, (x) => PALETTE[files.indexOf(x.filename.text) % PALETTE.length]);
  drawSourceSpace(band, i);
  const r = s.dst_rect;
  $("picked").innerHTML = `<b>Source ${i + 1}</b> of ${sourceRows(band).length}: <span class="name">${dsnChips(s.filename)}</span><br>` +
    `SrcRect ${s.src_rect ? s.src_rect.map(fmt).join(", ") : "whole"}, DstRect ${r ? r.map(fmt).join(", ") : "whole"}` +
    (s.declared_size ? `, ${s.declared_size.join(" x ")} declared` : "") +
    ` <button id="pickhdr">Read its header</button>`;
  $("pickhdr").onclick = async () => {
    const name = s.relative ? new URL(s.filename.text, state.base || location.href).href : s.filename.text;
    const url = urlOf(name, state.base);
    if (!url) { status(`No route from a browser to ${name}.`, true); return; }
    try {
      status(`Reading ${url} ...`);
      state.headers.set(name, await readTiffHeader(url));
      status(`Read the header of source ${i + 1}.`);
      drawSourceSpace(band, i);
    } catch (e) { status(e.message, true); }
  };
  for (const tr of $("sources").querySelectorAll("tr.pick")) tr.classList.toggle("on", Number(tr.dataset.i) === i);
}

// One source's own pixel grid: its blocks (when the header is read), the
// SrcRect it gives, and the window and blocks the last plan reads.
function drawSourceSpace(band, i) {
  const s = sourceRows(band)[i];
  const box = $("srcspace");
  if (!s) { box.innerHTML = ""; return; }
  const name = s.relative ? new URL(s.filename.text, state.base || location.href).href : s.filename.text;
  const h = state.headers.get(name) ?? state.headers.get(s.filename.text);
  const nested = state.nested.get(name)?.ds;
  const size = h ? [h.width, h.height] : s.declared_size ?? (nested ? [nested.x_size, nested.y_size] : null);
  if (!size) {
    box.innerHTML = `<p class="hint">Source ${i + 1}: size unknown until its header is read.</p>`;
    return;
  }
  const W = 520, pad = 24;
  const k = (W - 2 * pad) / Math.max(size[0], size[1]);
  const w = size[0] * k, hh = size[1] * k;
  const svg = [`<svg viewBox="0 0 ${w + 2 * pad} ${hh + 2 * pad + 18}" class="fig" role="img" aria-label="Source pixel grid">`];
  svg.push(`<rect x="${pad}" y="${pad}" width="${w}" height="${hh}" class="frame"/>`);
  // blocks the plan touches
  const touched = new Set();
  const leaves = state.plan?.band === band ? state.plan.leaves.filter((l) => l.dsn === norm(name) || l.dsn === s.filename.text) : [];
  if (h) {
    const [bw, bh] = h.block;
    for (const l of leaves) {
      const [x, y, xs, ys] = l.window.req_px;
      for (let by = Math.floor(y / bh); by <= Math.floor((y + ys - 1) / bh); by++)
        for (let bx = Math.floor(x / bw); bx <= Math.floor((x + xs - 1) / bw); bx++) touched.add(by * h.blocks[0] + bx);
    }
    if (h.blocks[0] * h.blocks[1] <= 20000) {
      for (let by = 0; by < h.blocks[1]; by++) for (let bx = 0; bx < h.blocks[0]; bx++) {
        const on = touched.has(by * h.blocks[0] + bx);
        svg.push(`<rect x="${pad + bx * bw * k}" y="${pad + by * bh * k}" width="${Math.min(bw, size[0] - bx * bw) * k}" height="${Math.min(bh, size[1] - by * bh) * k}" class="${on ? "blk on" : "blk"}"/>`);
      }
    }
  }
  const r = s.src_rect ?? [0, 0, size[0], size[1]];
  svg.push(`<rect x="${pad + r[0] * k}" y="${pad + r[1] * k}" width="${r[2] * k}" height="${r[3] * k}" class="srect"><title>SrcRect ${r.map(fmt).join(", ")}</title></rect>`);
  for (const l of leaves) {
    const [x, y, xs, ys] = l.window.req;
    svg.push(`<rect x="${pad + x * k}" y="${pad + y * k}" width="${xs * k}" height="${ys * k}" class="req"><title>planned read ${l.window.req.map(fmt).join(", ")}</title></rect>`);
  }
  svg.push(`<text x="${pad}" y="${pad + hh + 14}" class="ax">source ${i + 1} pixels, ${size[0]} x ${size[1]}</text>`);
  svg.push(`<text x="${pad}" y="${pad + hh + 30}" class="ax">${h ? `${h.layout} of ${h.block.join(" x ")}${touched.size ? `, ${plural(touched.size, "block")} of ${(h.blocks[0] * h.blocks[1]).toLocaleString("en")} read` : ""}` : "blocks: read the header"}; blue: SrcRect; black: the planned read</text></svg>`);
  box.innerHTML = svg.join("") + (h && touched.size && touched.size * 50 < h.blocks[0] * h.blocks[1] ? zoomSvg(h, leaves, s, size) : "") +
    (h ? `<p class="hint">${esc(h.format)}, ${esc(h.compression)}${h.predictor > 1 ? " with predictor " + h.predictor : ""}, ${h.bands} ${h.dataType} band${h.bands > 1 ? "s" : ""} ${esc(h.planar)}, ${plural(h.overviews.length, "overview")}${h.overviews.length ? " (" + h.overviews.map((o) => o.join("x")).join(", ") + ")" : ""}${h.epsg ? ", EPSG:" + h.epsg : ""}${h.nodata != null ? ", nodata " + esc(h.nodata) : ""}.</p>` : "") +
    (h ? overviewNote(h, leaves) : "");
}

// The blocks around a small read, close up.
function zoomSvg(h, leaves, s, size) {
  const [bw, bh] = h.block;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const l of leaves) {
    const [x, y, xs, ys] = l.window.req_px;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x + xs); y1 = Math.max(y1, y + ys);
  }
  const bx0 = Math.max(0, Math.floor(x0 / bw) - 1), by0 = Math.max(0, Math.floor(y0 / bh) - 1);
  const bx1 = Math.min(h.blocks[0], Math.ceil(x1 / bw) + 1), by1 = Math.min(h.blocks[1], Math.ceil(y1 / bh) + 1);
  const X0 = bx0 * bw, Y0 = by0 * bh, X1 = Math.min(size[0], bx1 * bw), Y1 = Math.min(size[1], by1 * bh);
  const W = 520, pad = 24, k = (W - 2 * pad) / Math.max(X1 - X0, Y1 - Y0);
  const cid = "zc" + Math.random().toString(36).slice(2, 8);
  const out = [`<svg viewBox="0 0 ${(X1 - X0) * k + 2 * pad} ${(Y1 - Y0) * k + 2 * pad + 4}" class="fig" style="margin-top:8px" role="img" aria-label="Blocks around the read">` +
    `<clipPath id="${cid}"><rect x="${pad}" y="${pad}" width="${(X1 - X0) * k}" height="${(Y1 - Y0) * k}"/></clipPath><g clip-path="url(#${cid})">`];
  let n = 0;
  for (let by = by0; by < by1; by++) for (let bx = bx0; bx < bx1; bx++) {
    const on = leaves.some((l) => { const [x, y, xs, ys] = l.window.req_px; return x < (bx + 1) * bw && x + xs > bx * bw && y < (by + 1) * bh && y + ys > by * bh; });
    if (on) n++;
    const rx = pad + (bx * bw - X0) * k, ry = pad + (by * bh - Y0) * k;
    out.push(`<rect x="${rx}" y="${ry}" width="${Math.min(bw, size[0] - bx * bw) * k}" height="${Math.min(bh, size[1] - by * bh) * k}" class="${on ? "blk on" : "blk"}"><title>block column ${bx}, row ${by}</title></rect>`);
    out.push(`<text x="${rx + 4}" y="${ry + 13}" class="ax">${bx},${by}</text>`);
  }
  const r = s.src_rect;
  if (r) out.push(`<rect x="${pad + (r[0] - X0) * k}" y="${pad + (r[1] - Y0) * k}" width="${r[2] * k}" height="${r[3] * k}" class="srect"/>`);
  for (const l of leaves) { const [x, y, xs, ys] = l.window.req; out.push(`<rect x="${pad + (x - X0) * k}" y="${pad + (y - Y0) * k}" width="${xs * k}" height="${ys * k}" class="req"/>`); }
  out.push(`</g></svg><p class="hint">Close up: the ${plural(n, "block")} the read needs at full resolution (column, row), with one block around.</p>`);
  return out.join("");
}

// A reduced read may come from an overview: the coarsest one whose
// reduction is no more than the read's, the usual rule (the reference
// library also has a tolerance, so this is a likely choice, not a promise).
function overviewNote(h, leaves) {
  if (!h.overviews.length || !leaves.length) return "";
  const l = leaves[0];
  const f = Math.min(l.window.req[2] / l.window.out[2], l.window.req[3] / l.window.out[3]);
  if (!(f > 1.2)) return "";
  let pick = null;
  for (const o of h.overviews) if (h.width / o[0] <= f) pick = o;
  if (!pick) return "";
  return `<p class="hint">This read reduces by ${fmt(+f.toFixed(2))}. A reader that uses overviews would likely read the ${pick.join(" x ")} overview (reduction ${fmt(+(h.width / pick[0]).toFixed(2))}) instead of these full-resolution blocks.</p>`;
}

async function readHeaders() {
  if (!state.classic) return;
  const names = new Map();
  const visit = (ds, base) => {
    for (const b of ds.bands) for (const s of b.sources) {
      const name = s.relative ? new URL(s.filename.text, base || location.href).href : s.filename.text;
      if (s.filename.virtual) {
        const n = state.nested.get(name);
        if (n?.ds) visit(n.ds, baseOf(urlOf(name, base) ?? ""));
        continue;
      }
      names.set(name, urlOf(name, base));
    }
  };
  visit(state.classic, state.base);
  const list = [...names].slice(0, 60);
  let done = 0, fail = 0;
  for (const [name, url] of list) {
    if (state.headers.has(name)) { done++; continue; }
    if (!url) { fail++; continue; }
    status(`Reading header ${done + fail + 1} of ${list.length}: ${url}`);
    try { state.headers.set(name, await readTiffHeader(url)); done++; } catch (e) { fail++; console.warn(name, e); }
  }
  const req = [...state.headers.values()].reduce((a, h) => a + h.requests, 0);
  const bytes = [...state.headers.values()].reduce((a, h) => a + h.bytes, 0);
  status(`Read ${plural(done, "header")} (${plural(req, "range request")}, ${(bytes / 1024).toFixed(0)} KB)${fail ? `; ${fail} could not be read from a browser` : ""}${names.size > list.length ? `; first ${list.length} of ${names.size}` : ""}.`);
  renderSources();
  runPlan();
}

function runPlan() {
  if (!state.classic) return;
  const band = Number($("pband").value || 1);
  const req = ["rx", "ry", "rw", "rh", "bx", "by"].map((id) => Number($(id).value));
  const sizes = {};
  // sizes the documents declare (SourceProperties), then headers read
  const declare = (ds, base) => {
    for (const b of ds.bands) for (const s of b.sources) {
      if (!s.declared_size) continue;
      for (const k of keysOf(s.filename.text, s.relative, base)) sizes[k] = s.declared_size;
    }
  };
  declare(state.classic, state.base);
  for (const [name, n] of state.nested) if (n.ds) declare(n.ds, baseOf(urlOf(name, state.base) ?? ""));
  for (const [name, h] of state.headers) sizes[name] = [h.width, h.height];
  const vrts = {};
  for (const [name, n] of state.nested) if (n.text) for (const k of n.keys ?? [name]) vrts[k] = n.text;
  // headers are keyed by normalised name; the planner may ask by the raw join
  const addRaw = (ds, base) => {
    for (const b of ds.bands) for (const s of b.sources) {
      const ks = keysOf(s.filename.text, s.relative, base);
      const h = state.headers.get(ks[ks.length - 1]);
      if (h) for (const k of ks) sizes[k] = [h.width, h.height];
    }
  };
  addRaw(state.classic, state.base);
  for (const [name, n] of state.nested) if (n.ds) addRaw(n.ds, baseOf(urlOf(name, state.base) ?? ""));
  const base = state.base ? state.base.replace(/\/$/, "") : "";
  const r = JSON.parse(vrtPlan(state.text, base, band, req, JSON.stringify({ sizes, vrts })));
  if (!r.ok) {
    state.plan = null;
    $("buffer").innerHTML = "";
    $("plan").innerHTML = `<p class="warn">The planner cannot plan this yet: ${esc(r.error)}.</p>` +
      (/Warped/.test(r.error) ? `<p class="hint">A warped VRT reads through a warp, not through windows; wxy-warp plans warps, and joining the two is listed in design m25 section 7.</p>` : "");
    return;
  }
  const p = r.plan;
  for (const l of p.leaves) l.dsn = norm(l.dsn);
  for (const x of p.rows) x.dsn = norm(x.dsn);
  state.plan = { band, req, leaves: p.leaves, rows: p.rows };
  const opsText = (ops) => ops.map((o) => o.op === "skip_nodata" ? `skip ${o.value}` : o.op === "linear" ? `x ${fmt(o.ratio)} + ${fmt(o.offset)}` : `LUT (${o.pairs.length} pairs)`).join(", ");
  const resampled = p.rows.filter((x) => x.resampled).length;
  const bandEl = kids(state.doc.documentElement, "VRTRasterBand")[band - 1];
  const nOvr = bandEl ? kids(bandEl, "Overview").length : 0;
  const red = Math.min(req[2] / req[4], req[3] / req[5]);
  $("plan").innerHTML =
    (nOvr && red > 1.2 ? `<p class="warn">This read reduces by ${fmt(+red.toFixed(1))}, and the band names ${plural(nOvr, "overview")}: the reference library would read the overview nearest that reduction, not these sources. The plan below is what the sources alone would need.</p>` : "") +
    (p.derived ? `<p>This band is computed by a pixel function: each row is one input, read into its own buffer of ${req[4]} x ${req[5]}, and the function combines them.</p>` : "") +
    `<p>${plural(p.rows.length, "source")} of ${sourceRows(band).length} touched${resampled ? `, ${resampled} resampled on the way` : ""}; ${plural(p.leaves.length, "read")} at the bottom of any nesting.</p>` +
    `<table><tr><th>source</th><th>reads (source pixels)</th><th>asks for</th><th>lands at (buffer)</th><th>operations, inner first</th><th>first columns sampled</th></tr>` +
    p.leaves.slice(0, 2000).map((l, i) => `<tr${i >= 50 ? ' class="fold"' : ""}><td class="name">${esc(l.dsn.replace(state.base, ""))} b${l.band}${l.mask ? " mask" : ""}</td>` +
      `<td>${l.window.req.map(fmt).join(", ")}</td><td>${l.window.req_px.join(", ")}</td><td>${l.window.out.join(", ")}</td>` +
      `<td>${l.ops.slice().reverse().map(opsText).filter(Boolean).join(" then ") || "none"}</td>` +
      `<td>${l.cols ? l.cols.slice(0, 12).join(" ") + (l.cols.length > 12 ? " ..." : "") : ""}</td></tr>`).join("") + "</table>" +
    foldNote(Math.min(2000, p.leaves.length), p.leaves.length, "read");
  wireFold($("plan"));
  drawBuffer(p, req);
  const bandSel = Number($("bandsel").value || 1);
  if (bandSel === band) {
    const files = [...new Set(sourceRows(band).map((s) => s.filename.text))];
    drawLayout(band, (s) => PALETTE[files.indexOf(s.filename.text) % PALETTE.length]);
    drawSourceSpace(band, state.picked?.band === band ? state.picked.i : 0);
  }
}

// The output buffer, with each read's landing region.
function drawBuffer(p, req) {
  const [bw, bh] = [req[4], req[5]];
  const W = 520, pad = 24;
  const k = (W - 2 * pad) / Math.max(bw, bh);
  const leaves = p.leaves;
  const names = [...new Set(leaves.map((l) => l.dsn))];
  const svg = [`<svg viewBox="0 0 ${bw * k + 2 * pad} ${bh * k + 2 * pad + 18}" class="fig" role="img" aria-label="Output buffer">`];
  svg.push(`<rect x="${pad}" y="${pad}" width="${bw * k}" height="${bh * k}" class="frame"/>`);
  leaves.slice(0, 3000).forEach((l, i) => {
    const [x, y, w, h] = l.window.out;
    const c = PALETTE[names.indexOf(l.dsn) % PALETTE.length];
    svg.push(`<rect x="${pad + x * k}" y="${pad + y * k}" width="${w * k}" height="${h * k}" fill="${c}" fill-opacity="0.35" stroke="${c}"><title>read ${i + 1}: ${esc(l.dsn)}\nlands at ${l.window.out.join(", ")}</title></rect>`);
  });
  if (bw * bh <= 4096) {
    for (let x = 1; x < bw; x++) svg.push(`<line x1="${pad + x * k}" y1="${pad}" x2="${pad + x * k}" y2="${pad + bh * k}" class="px"/>`);
    for (let y = 1; y < bh; y++) svg.push(`<line x1="${pad}" y1="${pad + y * k}" x2="${pad + bw * k}" y2="${pad + y * k}" class="px"/>`);
  }
  svg.push(`<text x="${pad}" y="${pad + bh * k + 14}" class="ax">the buffer, ${bw} x ${bh}; later reads paint over earlier ones</text></svg>`);
  $("buffer").innerHTML = svg.join("");
}

function renderMdim() {
  if (!section("s-mdim", !!state.mdim)) return;
  const groups = [];
  const walk = (g, depth) => { groups.push([g, depth]); g.groups.forEach((c) => walk(c, depth + 1)); };
  walk(state.mdim.root, 0);
  $("mgroups").innerHTML = `<table><tr><th>group</th><th>dimensions</th></tr>` + groups.map(([g, d]) =>
    `<tr><td style="padding-left:${6 + d * 14}px">${esc(g.path)}</td><td>${g.dims.map((x) => `${esc(x.name)} ${x.size}${x.type ? ` <span class="hint">${esc(x.type)}${x.direction ? " " + esc(x.direction) : ""}</span>` : ""}`).join(", ")}</td></tr>`).join("") + "</table>";
  const arrays = allArrays(state.mdim);
  $("marrays").innerHTML = `<table><tr><th>array</th><th>dimensions</th><th>type</th><th>unit</th><th>nodata, scale, offset</th><th>values from</th></tr>` +
    arrays.map((a) => {
      const from = a.values?.kind === "regular" ? `start ${fmt(a.values.start)}, step ${fmt(a.values.increment)}` : a.values?.kind === "inline" ? `${a.values.values.length} inline values` : a.sources?.length ? plural(a.sources.length, "source") : "";
      const el = state.doc.querySelector(`Array[name="${CSS.escape(a.name)}"]`);
      const derived = el && kid(el, "DerivedArray") ? "derived" : "";
      return `<tr><td>${esc(a.group === "/" ? "" : a.group)}/${esc(a.name)}</td><td>${a.dims.map((d, i) => `${esc(d.replace(/^.*\//, ""))} ${a.shape[i] ?? "?"}`).join(" x ")}</td>` +
        `<td>${esc(a.dtype ?? "")}</td><td>${esc(a.unit ?? "")}</td><td>${[["nodata", a.nodata], ["scale", a.scale], ["offset", a.offset]].filter(([, v]) => v != null).map(([k, v]) => `${k} ${esc(fmt(v))}`).join(", ")}</td><td>${esc(from || derived)}</td></tr>`;
    }).join("") + "</table>";
  // Overview levels stored as sibling arrays: name_x2, name_x4, ... on dims x_x2, ...
  const names = new Set(arrays.map((a) => a.name));
  const levelOf = (a) => { const m = a.name.match(/^(.+)_x(\d+)$/); return m && names.has(m[1]) ? { base: m[1], f: +m[2] } : null; };
  const levels = {};
  for (const a of arrays) { const l = levelOf(a); if (l && a.dims.length) (levels[l.base] ??= []).push(l.f); }
  const bases = Object.keys(levels).filter((b) => arrays.find((a) => a.name === b)?.sources?.length);
  if (bases.length) {
    const ex = bases[0], fs = levels[ex].sort((x, y) => x - y);
    const ovSrc = arrays.find((a) => a.name === `${ex}_x${fs[0]}`)?.sources?.[0]?.file ?? "";
    $("marrays").innerHTML += `<p class="hint">${plural(bases.length, "array")} (${bases.map(esc).join(", ")}) come${bases.length === 1 ? "s" : ""} with overview levels as sibling arrays: <code>${esc(ex)}_x${fs.join("</code>, <code>_x")}</code>, each on its own reduced dimensions.` +
      (/^GTIFF_DIR:\d+:/.test(ovSrc) ? ` Their sources name the source TIFF's internal overviews with <code>GTIFF_DIR:n:</code>, so each level reads bytes that already exist.` : "") +
      ` A multidimensional VRT has no overview element of its own; this naming is a convention a reader has to know.</p>`;
  }
  const data = arrays.filter((a) => a.sources?.some((x) => x.kind === "Source"));
  const dimArray = (d) => arrays.find((x) => x.dims.length === 1 && x.dims[0] === d);
  const one = (a) => {
    const s = a.sources;
    const kinds = [...new Set(s.map((x) => x.kind))].join(", ");
    const files = new Set(s.map((x) => x.file));
    const names = s.map((x) => x.file);
    let prefix = names[0] ?? "";
    for (const n of names) while (!n.startsWith(prefix)) prefix = prefix.slice(0, -1);
    prefix = prefix.slice(0, prefix.lastIndexOf("/") + 1);
    const d0 = JSON.parse(vrtDsn(s[0].file));
    const noCount = s.filter((x) => x.kind === "Source" && !x.srcCount).length;
    const len = a.shape[0] ?? 0;
    const cover = new Uint8Array(Math.min(len, 1e6));
    for (const x of s) {
      const off = x.destOffset?.[0] ?? 0;
      const cnt = x.srcCount?.[0] ?? 1; // the slab is in the destination's axis order
      for (let i = off; i < Math.min(off + cnt, cover.length); i++) cover[i] = 1;
    }
    const filled = cover.reduce((p, v) => p + v, 0);
    let gaps = "";
    if (filled < cover.length) {
      const runs = [];
      for (let i = 0; i < cover.length; i++) if (!cover[i]) { let j = i; while (j + 1 < cover.length && !cover[j + 1]) j++; runs.push([i, j]); i = j; }
      const ca = dimArray(a.dims[0]);
      const toDate = cfTime(ca?.unit);
      const at = (i) => { const v = coordValue(ca, i); return v == null ? "" : toDate ? toDate(v).toISOString().slice(0, 10) : fmt(v); };
      const show = (r) => `${r[0]}${r[1] > r[0] ? "-" + r[1] : ""}${at(r[0]) ? ` (${at(r[0])}${r[1] > r[0] ? " to " + at(r[1]) : ""})` : ""}`;
      gaps = `<p class="hint">${(cover.length - filled).toLocaleString("en")} ${cover.length - filled === 1 ? "index" : "indices"} with no source, in ${plural(runs.length, "run")}: ${runs.slice(0, 8).map(show).join("; ")}${runs.length > 8 ? "; ..." : ""}. A read there gets nodata.</p>`;
    }
    return `<h3>${esc(a.name)}: ${plural(s.length, "source")} (${esc(kinds)}) over ${plural(files.size, "file")}</h3>` +
      `<p class="name">first: ${dsnChips(d0)} <button class="mhdr" data-file="${esc(s[0].file)}">Read its header</button></p><div class="mhdrout"></div>` +
      (prefix.length > 8 ? `<p class="hint">Common prefix: <code>${esc(prefix)}</code></p>` : "") +
      `<table><tr><th>#</th><th>file (after the prefix)</th><th>band or array</th><th>transpose</th><th>SourceSlab offset / count</th><th>DestSlab</th></tr>` +
      [...s.slice(0, 3), ...(s.length > 6 ? [null] : []), ...s.slice(Math.max(3, s.length - 3))].map((x, j) => x == null
        ? `<tr><td colspan="6" class="hint">... ${(s.length - 6).toLocaleString("en")} more like these</td></tr>`
        : `<tr><td>${s.indexOf(x) + 1}</td><td class="name">${esc(x.file.slice(prefix.length > 8 ? prefix.length : 0))}</td><td>${esc(x.array ?? x.band ?? "")}</td><td>${esc(x.transpose?.join(",") ?? "")}</td>` +
          `<td>${esc(x.srcOffset?.join(",") ?? "")} / ${esc(x.srcCount?.join(",") ?? "none")}</td><td>${esc(x.destOffset?.join(",") ?? "")}</td></tr>`).join("") + "</table>" +
      (len ? stripSvg(cover, a.dims[0]?.replace(/^.*\//, "") ?? "axis 0", filled) + gaps : "") +
      (noCount ? `<p class="warn">${plural(noCount, "source")} without a SourceSlab count: the reference library opens each to learn its shape, on every read.</p>` : "");
  };
  const main = data.filter((a) => !levelOf(a)), ovs = data.filter((a) => levelOf(a));
  $("msources").innerHTML = main.map(one).join("") +
    (ovs.length ? `<details><summary>Sources of the ${plural(ovs.length, "overview-level array")}</summary>${ovs.map(one).join("")}</details>` : "");
}

async function mdimHeader(btn) {
  const out = btn.parentElement.nextElementSibling;
  const url = urlOf(btn.dataset.file, state.base);
  if (!url) { out.innerHTML = `<p class="warn">No route from a browser to this source.</p>`; return; }
  out.innerHTML = `<p class="hint">Reading ${esc(url)} ...</p>`;
  try {
    const h = await readTiffHeader(url);
    out.innerHTML = `<p class="hint">${h.width} x ${h.height} ${h.dataType}, ${h.layout} of ${h.block.join(" x ")} (${(h.blocks[0] * h.blocks[1]).toLocaleString("en")} per image), ${esc(h.compression)}${h.predictor > 1 ? " with predictor " + h.predictor : ""}, ${plural(h.overviews.length, "overview")}${h.epsg ? ", EPSG:" + h.epsg : ""}${h.nodata != null ? ", nodata " + esc(h.nodata) : ""}; ${plural(h.requests, "range request")}, ${(h.bytes / 1024).toFixed(0)} KB.</p>`;
  } catch (e) {
    if (e.message !== "not a TIFF") { out.innerHTML = `<p class="warn">${e instanceof TypeError ? "The browser could not read it (the host is unreachable or sends no CORS headers): " : ""}${esc(e.message)}</p>`; return; }
    out.innerHTML = await sniff(url);
  }
}

// Name the format of a file that is not a TIFF, from its first bytes.
async function sniff(url) {
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-7" } });
    const b = new Uint8Array(await r.arrayBuffer()).slice(0, 8);
    const size = r.headers.get("content-range")?.split("/")[1];
    const sz = size && size !== "*" ? `, ${(+size / 1048576).toFixed(1)} MB` : "";
    const sig = String.fromCharCode(...b);
    const kind = sig.startsWith("\x89HDF") ? "netCDF-4 (HDF5)" : sig.startsWith("CDF\x01") ? "classic netCDF" : sig.startsWith("CDF\x02") ? "netCDF 64-bit offset" : sig.startsWith("CDF\x05") ? "netCDF 64-bit data" : sig.startsWith("GRIB") ? "GRIB" : null;
    return `<p class="hint">${kind ? `A ${kind} file${sz}.` : `Not a TIFF (first bytes ${[...b].map((x) => x.toString(16).padStart(2, "0")).join(" ")})${sz}.`} This page reads TIFF headers only.` +
      (kind?.startsWith("netCDF-4") ? " Its chunks are found by walking the HDF5 B-trees, the job a byte-reference harvester does once so readers do not have to." : "") + "</p>";
  } catch (e) {
    return `<p class="warn">Not a TIFF, and the first bytes could not be read: ${esc(e.message)}</p>`;
  }
}

// Which indices of the first axis the sources fill.
function stripSvg(cover, axis, filled) {
  const W = 520, H = 22, n = cover.length;
  const bins = Math.min(n, W);
  const cells = [];
  for (let b = 0; b < bins; b++) {
    const i0 = Math.floor((b * n) / bins), i1 = Math.max(i0 + 1, Math.floor(((b + 1) * n) / bins));
    let c = 0;
    for (let i = i0; i < i1; i++) c += cover[i];
    const f = c / (i1 - i0);
    cells.push(`<rect x="${(b * W) / bins}" y="0" width="${W / bins + 0.3}" height="${H}" fill="var(--accent)" fill-opacity="${(0.1 + 0.9 * f).toFixed(2)}"/>`);
  }
  return `<svg viewBox="0 0 ${W} ${H + 16}" class="strip" role="img" aria-label="Coverage along ${esc(axis)}">${cells.join("")}` +
    `<text x="0" y="${H + 13}" class="ax">${esc(axis)} 0</text><text x="${W}" y="${H + 13}" class="ax" text-anchor="end">${n.toLocaleString("en")}: ${filled.toLocaleString("en")} filled</text></svg>`;
}

function wireMdim() {
  for (const b of document.querySelectorAll("button.mhdr")) b.onclick = () => mdimHeader(b);
}

function renderVector() {
  if (!section("s-vector", !!state.vector)) return;
  const rows = [];
  const walk = (l, depth) => {
    const d = l.source ? JSON.parse(vrtDsn(l.source.name)) : null;
    rows.push(`<tr><td style="padding-left:${6 + depth * 14}px"><b>${esc(l.name ?? "")}</b> <span class="hint">${esc(l.kind)}</span></td>` +
      `<td class="name">${d ? dsnChips(d) : ""}${l.source?.relative ? ' <span class="hint">relative</span>' : ""}</td>` +
      `<td>${l.sql ? `<code>${esc(l.sql)}</code>${l.dialect ? ` <span class="hint">${esc(l.dialect)}</span>` : ""}` : esc(l.srcLayer ?? (l.kind === "Layer" ? "(layer named like this one)" : ""))}</td>` +
      `<td>${l.geoms.map((g) => `${esc(g.encoding ?? "")}${g.x ? ` x=${esc(g.x)} y=${esc(g.y)}` : ""}${g.field ? ` from ${esc(g.field)}` : ""}${g.type ? ` <span class="hint">${esc(g.type)}</span>` : ""}`).join("<br>")}</td>` +
      `<td>${l.fields.length ? l.fields.map((f) => `${esc(f.name)}${f.src && f.src !== f.name ? " &lt;- " + esc(f.src) : ""} <span class="hint">${esc(f.type)}</span>`).join("<br>") : l.kind === "Layer" ? "all source fields" : esc(l.fieldStrategy ?? "")}</td>` +
      `<td>${esc(l.targetSRS ? `${l.srcSRS ?? "source"} to ${l.targetSRS}` : l.geoms.map((g) => g.srs).filter(Boolean).join(", "))}</td></tr>`);
    l.children.forEach((c) => walk(c, depth + 1));
  };
  state.vector.layers.forEach((l) => walk(l, 0));
  $("vlayers").innerHTML = `<table><tr><th>layer</th><th>source</th><th>layer or SQL</th><th>geometry</th><th>fields</th><th>CRS</th></tr>${rows.join("")}</table>`;
}

function renderCensus() {
  const c = state.census;
  if (!section("s-census", !!c)) return;
  const fam = state.family;
  const rows = [...c].map(([name, v]) => {
    const e = ELEMENTS[name];
    return `<tr${e ? "" : ' class="unk"'}><td><code>${esc(name)}</code></td><td>${v.n.toLocaleString("en")}</td><td>${esc([...v.parents].join(", "))}</td><td>${esc(e ? e[1] : "Not in this page's dictionary.")}</td></tr>`;
  });
  $("census").innerHTML = `<table><tr><th>element</th><th>count</th><th>inside</th><th>what it does</th></tr>${rows.join("")}</table>`;
}

// The document as a tree, built as it is opened (a VRT can have a hundred
// thousand elements). Runs of more than six siblings with one name show
// the first three and the last.
function renderTree() {
  if (!section("s-tree", !!state.doc)) return;
  const box = $("tree");
  box.innerHTML = "";
  box.append(node(state.doc.documentElement, true));
}

function node(el, open = false) {
  const det = document.createElement("details");
  const kidsEls = Array.from(el.children);
  const attrs = Array.from(el.attributes).map((a) => ` <span class="an">${esc(a.name)}</span>=<span class="av">"${esc(a.value.length > 80 ? a.value.slice(0, 80) + "..." : a.value)}"</span>`).join("");
  const text = kidsEls.length ? "" : el.textContent.trim();
  const e = ELEMENTS[el.tagName];
  const sum = document.createElement("summary");
  sum.innerHTML = `<span class="tag">&lt;${esc(el.tagName)}</span>${attrs}<span class="tag">&gt;</span>` +
    (text ? ` <span class="tv">${esc(text.length > 120 ? text.slice(0, 120) + "..." : text)}</span>` : "") +
    (kidsEls.length ? ` <span class="hint">${kidsEls.length}</span>` : "") +
    (e ? ` <span class="ex">${esc(e[1])}</span>` : "");
  if (e) sum.title = e[1];
  det.append(sum);
  if (!kidsEls.length) { det.classList.add("leaf"); return det; }
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    let i = 0;
    while (i < kidsEls.length) {
      let j = i;
      while (j < kidsEls.length && kidsEls[j].tagName === kidsEls[i].tagName) j++;
      const run = j - i;
      if (run > 6) {
        for (let k = i; k < i + 3; k++) det.append(node(kidsEls[k]));
        const more = document.createElement("div");
        more.className = "more";
        more.textContent = `... ${(run - 4).toLocaleString("en")} more <${kidsEls[i].tagName}> ...`;
        det.append(more);
        det.append(node(kidsEls[j - 1]));
      } else {
        for (let k = i; k < j; k++) det.append(node(kidsEls[k]));
      }
      i = j;
    }
  };
  det.addEventListener("toggle", build);
  if (open) { build(); det.open = true; }
  return det;
}

function renderText() {
  if (!section("s-text", state.text != null)) return;
  const t = state.text;
  $("doc").textContent = t.length > 200000 ? t.slice(0, 200000) + `\n\n... (${(t.length - 200000).toLocaleString("en")} more characters)` : t;
}

// ---------------------------------------------------------------- name tool

const NAME_EXAMPLES = [
  "/vsizip/{/vsicurl/https://example.org/tiles.zip}/a/b.tif",
  "NETCDF:\"/vsicurl/https://example.org/sst.nc\":analysed_sst",
  "vrt://NETCDF:\"sst.nc\":analysed_sst?srcwin=0,0,100,100&a_srs=EPSG:4326",
  "vrt://vrt://a.tif?bands=2?outsize=50%,50%",
  "/vsis3/bucket/key/scene.tif",
  "HDF5:\"file.h5\"://group/var",
];

function parseName() {
  const s = $("nm").value.trim();
  if (!s) { $("nmout").innerHTML = ""; return; }
  const d = JSON.parse(vrtDsn(s));
  const steps = [];
  let cur = d;
  while (cur) {
    steps.push(`<li><b>${esc(dsnKind(cur))}</b>: <code>${esc(cur.text)}</code></li>`);
    cur = cur.inner ?? cur.source ?? null;
  }
  $("nmout").innerHTML = `<p class="name">${dsnChips(d)}</p><ol>${steps.join("")}</ol>` +
    `<p class="hint">The bytes come from <code>${esc(d.leaf)}</code>${urlOf(d.leaf, location.href) ? " (a browser can reach it)" : ""}. ` +
    `${d.virtual ? "This name is itself a VRT, so a reader goes through it." : ""} vrt-model writes it back as <code>${esc(d.text)}</code>${d.text === s ? ", the same string" : ""}.</p>`;
}

// ---------------------------------------------------------------- page

async function main() {
  const sel = $("examples");
  sel.innerHTML = `<option value="">Examples ...</option>` + EXAMPLES.map(([g, list]) =>
    `<optgroup label="${esc(g)}">${list.map(([l, u]) => `<option value="${esc(u)}">${esc(l)}</option>`).join("")}</optgroup>`).join("");
  sel.onchange = () => { if (sel.value) { $("src").value = sel.value; load(sel.value); } };
  $("go").onclick = () => load($("src").value.trim());
  $("src").onkeydown = (e) => { if (e.key === "Enter") load($("src").value.trim()); };
  $("pastego").onclick = () => load("pasted", $("paste").value);
  $("bandsel").onchange = renderSources;
  $("planbtn").onclick = runPlan;
  $("hdrbtn").onclick = readHeaders;
  $("nm").oninput = parseName;
  $("nmex").innerHTML = NAME_EXAMPLES.map((n) => `<button class="ex-name">${esc(n)}</button>`).join(" ");
  for (const b of $("nmex").querySelectorAll("button")) b.onclick = () => { $("nm").value = b.textContent; parseName(); };
  status("Loading wasm ...");
  await init();
  const q = new URLSearchParams(location.search).get("src");
  const first = q ?? CORPUS + "c09-nested.vrt";
  $("src").value = first;
  $("nm").value = NAME_EXAMPLES[0];
  parseName();
  await load(first);
}

main();
