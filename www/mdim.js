// A multidimensional VRT read in the browser: the VRT parsed in plain
// JavaScript (mdim-vrt.js), each slice's source COG read and warped by
// wxy-tiff and wxy-warp in wasm, the VRT's nodata, scale and offset applied
// here.
import init, { Cog, Transform } from "./pkg/wxy_web.js";
import { parseMdimVrt, allArrays, sourcesAt, coordValue, cfTime, indexSources } from "./mdim-vrt.js";

const DEFAULT_VRT = "https://data.source.coop/ausantarctic/ghrsst-mur-v2/ghrsst-mur-v2.vrt";

// extents are [xmin, xmax, ymin, ymax]
const PROJS = {
  longlat: { name: "Longitude / latitude (EPSG:4326)", crs: "EPSG:4326", extent: [-180, 180, -90, 90] },
  south: { name: "South polar stereographic (EPSG:3031)", crs: "EPSG:3031", extent: [-5e6, 5e6, -2.5e6, 2.5e6] },
  north: { name: "North polar stereographic (EPSG:3413)", crs: "EPSG:3413", extent: [-5e6, 5e6, -2.5e6, 2.5e6] },
  tas: { name: "Lambert azimuthal, Tasmania", crs: "+proj=laea +lat_0=-43 +lon_0=147 +datum=WGS84",
         extent: [-1.2e6, 1.2e6, -6e5, 6e5] },
  moll: { name: "Mollweide", crs: "+proj=moll +datum=WGS84", extent: [-1.81e7, 1.81e7, -9.05e6, 9.05e6] },
};

// Colour ramps as [stop, r, g, b].
const VIRIDIS = [[0, 68, 1, 84], [0.25, 59, 82, 139], [0.5, 33, 145, 140], [0.75, 94, 201, 98], [1, 253, 231, 37]];
const THERMAL = [[0, 4, 35, 51], [0.15, 23, 70, 155], [0.35, 76, 127, 196], [0.5, 158, 190, 196], [0.62, 238, 206, 146],
                 [0.78, 224, 128, 68], [0.9, 180, 48, 52], [1, 103, 0, 31]];
const DIVERGE = [[0, 33, 102, 172], [0.25, 103, 169, 207], [0.5, 247, 247, 247], [0.75, 239, 138, 98], [1, 178, 24, 43]];
const ICE = [[0, 8, 48, 107], [0.5, 107, 174, 214], [1, 247, 251, 255]];
// a known array name gives a fixed range; anything else is stretched
const STYLE = {
  analysed_sst: { ramp: THERMAL, range: [-2, 32] },
  sst_anomaly: { ramp: DIVERGE, range: [-4, 4] },
  sea_ice_fraction: { ramp: ICE, range: [0, 1] },
  analysis_error: { ramp: VIRIDIS, range: [0, 1] },
  mask: { ramp: VIRIDIS, range: [1, 13], resampling: "mode" },
};

const $ = (id) => document.getElementById(id);
const canvas = $("map"), ctx = canvas.getContext("2d");

let vrt = null, arrays = [], A = null, T = null;   // the VRT, its arrays, the current array, its time axis
let crs = "EPSG:4326", extent = PROJS.longlat.extent.slice();
let range = null, last = null;                     // colour range, the last rendered slice
let busy = false, pending = null, stoken = 0;
const net = { requests: 0, bytes: 0 };

function say(text, error = false) {
  $("status").textContent = text;
  $("status").className = error ? "error" : "";
}
const mb = (b) => (b / 1e6).toFixed(b < 1e7 ? 2 : 1);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

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

function fitAspect([x0, x1, y0, y1]) {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  let w = x1 - x0, h = y1 - y0;
  const a = canvas.width / canvas.height;
  if (w / h > a) h = w / a; else w = h * a;
  return [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
}

// ---- the VRT ---------------------------------------------------------------

// Fetch with a progress line: the full GHRSST VRT is 16.6 MB of XML.
async function fetchText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const total = +r.headers.get("content-length") || 0;
  if (!r.body) return r.text();
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    say(`Fetching ${url}: ${mb(got)}${total ? " of " + mb(total) : ""} MB`);
  }
  return { text: new TextDecoder().decode(await new Blob(parts).arrayBuffer()), bytes: got };
}

// The time (first) axis of an array: its indexing array and a labeller.
function firstAxis(a) {
  const d = a.dimInfo[0];
  const coord = arrays.find((x) => x.name === (d.indexingVariable ?? d.name) && x.dims.length === 1);
  const toDate = cfTime(coord?.unit);
  return {
    name: d.name, size: a.shape[0], coord,
    label(i) {
      const v = coordValue(coord, i);
      if (v == null) return `${d.name} ${i}`;
      if (toDate) return toDate(v).toISOString().slice(0, 10);
      return `${d.name} = ${v}${coord.unit ? " " + coord.unit : ""}`;
    },
  };
}

// The 2D (and more) arrays with sources this page can read.
const readable = (a) => a.dims.length >= 3 && a.sources.some((s) => s.kind === "Source");

function coordText(a) {
  const v = a.values;
  if (!v) return "";
  if (v.kind === "regular") {
    const n = a.shape[0], last = v.start + (n - 1) * v.increment;
    const lbl = cfTime(a.unit);
    if (lbl) return `${lbl(v.start).toISOString().slice(0, 10)} to ${lbl(last).toISOString().slice(0, 10)}, step ${v.increment}`;
    return `${+v.start.toFixed(6)} to ${+last.toFixed(6)}, step ${v.increment}`;
  }
  return `${v.values.length} inline values`;
}

function showTables() {
  const dims = [];
  const walk = (g) => { dims.push(...g.dims.map((d) => ({ ...d, group: g.path }))); g.groups.forEach(walk); };
  walk(vrt.root);
  $("dims").innerHTML = "<tr><th>dimension</th><th>size</th><th>type</th><th>values</th></tr>" +
    dims.map((d) => {
      const c = arrays.find((a) => a.name === (d.indexingVariable ?? d.name) && a.dims.length === 1);
      return `<tr><td>${esc(d.name)}</td><td>${d.size.toLocaleString()}</td><td>${esc(d.type ?? "")}</td>` +
             `<td>${esc(c ? coordText(c) : "")}${c?.unit ? " <span class=hint>" + esc(c.unit) + "</span>" : ""}</td></tr>`;
    }).join("");
  $("arrays").innerHTML = "<tr><th>array</th><th>type</th><th>shape</th><th>unit, scale, offset</th><th>sources</th></tr>" +
    arrays.filter((a) => a.dims.length > 1).map((a) => {
      const so = [a.unit, a.scale != null ? "x " + a.scale : "", a.offset != null ? "+ " + a.offset : ""].filter(Boolean).join(", ");
      return `<tr class="${readable(a) ? "pick" : ""}${a === A ? " sel" : ""}" data-name="${esc(a.name)}">` +
             `<td>${esc(a.name)}</td><td>${esc(a.dtype)}</td><td>${a.shape.join(" x ")}</td>` +
             `<td>${esc(so)}</td><td>${a.sources.length.toLocaleString()}</td></tr>`;
    }).join("");
  for (const tr of $("arrays").querySelectorAll("tr.pick")) {
    tr.onclick = () => { $("array").value = tr.dataset.name; chooseArray(); };
  }
}

// The <Source> element for a slice, written back from what was parsed, as
// HTML: escaped, with the DestSlab index that matched picked out.
function sourceXml(s) {
  const L = ["<Source>"];
  L.push(`  <SourceFilename>${s.file}</SourceFilename>`);
  if (s.band != null) L.push(`  <SourceBand>${s.band}</SourceBand>`);
  if (s.array) L.push(`  <SourceArray>${s.array}</SourceArray>`);
  if (s.transpose) L.push(`  <SourceTranspose>${s.transpose.join(",")}</SourceTranspose>`);
  if (s.view) L.push(`  <SourceView>${s.view}</SourceView>`);
  if (s.srcOffset) L.push(`  <SourceSlab offset="${s.srcOffset}" count="${s.srcCount}" step="${s.srcStep}"/>`);
  let html = L.map(esc).join("\n");
  if (s.destOffset) {
    const rest = s.destOffset.length > 1 ? "," + s.destOffset.slice(1) : "";
    html += `\n  ${esc("<DestSlab offset=\"")}<span class="hl">${s.destOffset[0]}</span>${rest}${esc("\"/>")}`;
  }
  return html + "\n" + esc("</Source>");
}

async function loadVrt(url) {
  stoken++;
  cogs.forEach((p) => p.then((c) => c.free(), () => {}));
  cogs.clear();
  const t0 = performance.now();
  let res;
  try {
    res = await fetchText(url);
  } catch (e) {
    say(`Could not fetch ${url}: ${e.message}. The server must allow CORS.`, true);
    return;
  }
  const { text, bytes } = typeof res === "string" ? { text: res, bytes: res.length } : res;
  const t1 = performance.now();
  try {
    vrt = parseMdimVrt(text, new URL(url, location.href).href);
  } catch (e) {
    say(String(e.message || e), true);
    return;
  }
  arrays = allArrays(vrt);
  arrays.forEach(indexSources);
  const t2 = performance.now();
  const nsrc = arrays.reduce((s, a) => s + a.sources.length, 0);
  net.vrt = `${mb(bytes)} MB of XML fetched in ${((t1 - t0) / 1000).toFixed(1)} s and parsed in ` +
            `${((t2 - t1) / 1000).toFixed(2)} s: ${arrays.length} arrays, ${nsrc.toLocaleString()} sources`;
  say(net.vrt);
  const sel = $("array");
  sel.innerHTML = "";
  for (const a of arrays.filter(readable)) sel.add(new Option(`${a.name} (${a.shape.join(" x ")})`, a.name));
  if (!sel.options.length) { showTables(); say(net.vrt + ". No array here has sources to read.", true); return; }
  const q = new URLSearchParams(location.search);
  if (q.get("array") && arrays.some((a) => a.name === q.get("array") && readable(a))) sel.value = q.get("array");
  A = null;
  chooseArray(q.get("t"));
}

function chooseArray(t = null) {
  const prev = A ? +$("t").value : null;
  A = arrays.find((a) => a.name === $("array").value);
  T = firstAxis(A);
  const r = $("t");
  r.max = T.size - 1;
  // keep the step, else start at the last one that has a source
  let i = t != null ? +t : prev;
  if (i == null || i > T.size - 1) {
    i = T.size - 1;
    while (i > 0 && !sourcesAt(A, [i]).length) i--;
  }
  r.value = i;
  const st = STYLE[A.name] ?? {};
  range = st.range ? st.range.slice() : null;
  if (st.resampling) $("resampling").value = st.resampling;
  $("units").textContent = A.unit ?? "";
  showTables();
  render();
}

// ---- reading a slice -------------------------------------------------------

// Open COGs, kept for the last few slices so stepping back is cheap.
const cogs = new Map();
function cogFor(url) {
  if (cogs.has(url)) {
    const p = cogs.get(url);
    cogs.delete(url); cogs.set(url, p);           // most recently used last
    return p;
  }
  const p = Cog.open(url);
  cogs.set(url, p);
  while (cogs.size > 6) {
    const [k, old] = cogs.entries().next().value;
    cogs.delete(k);
    old.then((c) => c.free(), () => {});
  }
  p.catch(() => cogs.delete(url));
  return p;
}

// Raw values to the VRT's units: nodata to NaN, then scale and offset.
function physical(a, raw) {
  const s = a.scale ?? 1, o = a.offset ?? 0, nd = a.nodata;
  const out = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    out[i] = Number.isFinite(v) && v !== nd ? v * s + o : NaN;
  }
  return out;
}

function percentiles(values) {
  const v = Array.from(values).filter(Number.isFinite);
  if (!v.length) return [0, 1];
  v.sort((a, b) => a - b);
  return [v[Math.floor(v.length * 0.02)], v[Math.floor(v.length * 0.98)]];
}

function draw(values, w, h) {
  const st = STYLE[A.name] ?? {};
  if (!range) range = percentiles(values);
  $("vmin").value = +range[0].toPrecision(4);
  $("vmax").value = +range[1].toPrecision(4);
  const [lo, hi] = range, stops = st.ramp ?? VIRIDIS;
  const img = ctx.createImageData(w, h), px = img.data;
  for (let i = 0; i < w * h; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const c = ramp(stops, (v - lo) / (hi - lo || 1));
    px[4 * i] = c[0]; px[4 * i + 1] = c[1]; px[4 * i + 2] = c[2]; px[4 * i + 3] = 255;
  }
  if (w === canvas.width) {
    ctx.putImageData(img, 0, 0);
  } else {
    createImageBitmap(img).then((bmp) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    });
  }
  const bar = $("bar").getContext("2d"), bi = bar.createImageData(256, 1);
  for (let i = 0; i < 256; i++) {
    const c = ramp(stops, i / 255);
    bi.data.set([c[0], c[1], c[2], 255], 4 * i);
  }
  bar.putImageData(bi, 0, 0);
  $("lo").textContent = +lo.toPrecision(4);
  $("hi").textContent = +hi.toPrecision(4);
}

// Compare the VRT's x and y coordinates with the COG's own grid.
function gridCheck(info) {
  const gt = info.geotransform;
  const n = A.dims.length;
  const cx = arrays.find((a) => a.name === (A.dimInfo[n - 1].indexingVariable ?? A.dimInfo[n - 1].name));
  const cy = arrays.find((a) => a.name === (A.dimInfo[n - 2].indexingVariable ?? A.dimInfo[n - 2].name));
  if (!gt || !cx?.values || !cy?.values) return "";
  const x0 = gt[0] + gt[1] / 2, y0 = gt[3] + gt[5] / 2;
  const vx = coordValue(cx, 0), vy = coordValue(cy, 0);
  const sizeOk = info.width === A.shape[n - 1] && info.height === A.shape[n - 2];
  const tol = Math.abs(gt[1]) * 1e-6;
  const agree = sizeOk && Math.abs(x0 - vx) < tol && Math.abs(y0 - vy) < tol;
  const s = sourcesAt(A, [+$("t").value]).pop()?.source;
  const c = s?.srcCount, o = s?.srcOffset;
  const whole = (!c || (c[n - 1] === info.width && c[n - 2] === info.height)) &&
                (!o || o.every((v) => v === 0)) && !s?.view;
  const warn = whole ? "" : "NOTE: this source's SourceSlab or SourceView selects part of the band; this page " +
                            "reads the whole band, so the picture is not what GDAL would read. ";
  return warn + `The COG is ${info.width} x ${info.height} (${info.crs ?? "no EPSG code"}), first cell centre ` +
         `${+x0.toFixed(6)}, ${+y0.toFixed(6)}; the VRT says ${A.shape[n - 1]} x ${A.shape[n - 2]} starting at ` +
         `${+vx.toFixed(6)}, ${+vy.toFixed(6)}: ${agree ? "they agree" : "THEY DIFFER"}. ` +
         `${info.overviews.length} overviews in the COG; the warp reads the one gdalwarp would. The VRT itself has no ` +
         `overviews, so a GDAL read of this view through the VRT would read full resolution.`;
}

async function render(quick = false) {
  if (!A) return;
  if (busy) { pending = quick; return; }
  busy = true;
  const t = +$("t").value;
  $("tlabel").textContent = `${T.label(t)} (${T.name} ${t} of ${T.size})`;
  const hits = sourcesAt(A, [t]);
  const hit = hits[hits.length - 1];
  try {
    if (!hit) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      last = null;
      $("srcxml").textContent = `No <Source> covers ${T.name} ${t}: GDAL reads nodata here.`;
      $("check").textContent = "";
      say(`${T.label(t)}: no source.`);
      return;
    }
    $("srcxml").innerHTML = sourceXml(hit.source) +
      (hits.length > 1 ? `\n\n(${hits.length} sources overlap here; the last one wins)` : "");
    const s = hit.source;
    if (!s.url || s.band == null) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      last = null;
      say(`This source is ${s.band == null ? "an array (SourceArray), not a raster band" : "not reachable over HTTP"}; ` +
          `this page reads COG bands only.`, true);
      return;
    }
    const f = quick ? 2 : 1;
    const w = Math.round(canvas.width / f), h = Math.round(canvas.height / f);
    const alg = quick ? "near" : $("resampling").value;
    const t0 = performance.now();
    const cog = await cogFor(s.url);
    const info = JSON.parse(cog.info());
    const out = await cog.warp(crs, extent, w, h, alg);
    const ms = performance.now() - t0;
    if (out.bands !== 1 && s.band !== 1) throw new Error("multi-band sources are not handled yet");
    const vals = physical(A, out.values.subarray((s.band - 1) * w * h, s.band * w * h));
    draw(vals, w, h);
    last = { vals, w, h, t, extent: extent.slice() };
    $("check").textContent = gridCheck(info);
    const level = out.level === 0 ? "full resolution" : `overview ${out.level} of ${info.overviews.length}`;
    say(`${T.label(t)}: ${s.url.split("/").pop()}, ${level}, ${alg}, ${ms.toFixed(0)} ms. ` +
        `This file: ${out.requests} range requests, ${mb(out.bytes)} MB. ${net.vrt}.`);
  } catch (e) {
    say(String(e.message || e), true);
  } finally {
    busy = false;
    if (pending !== null) { const q = pending; pending = null; render(q); }
  }
}

// ---- a series at one cell --------------------------------------------------

async function series(viewXY) {
  const my = ++stoken, t0 = +$("t").value, n = +$("slen").value;
  const first = Math.max(0, Math.min(T.size - n, t0 - Math.floor(n / 2)));
  const steps = Array.from({ length: Math.min(n, T.size) }, (_, i) => first + i);
  const vals = new Array(steps.length).fill(undefined);
  let done = 0, req = 0, bytes = 0, lonlat = null;
  const svg = $("series");
  const plot = () => {
    const got = vals.filter((x) => x !== undefined && !Number.isNaN(x));
    let lo = got.length ? Math.min(...got) : 0, hi = got.length ? Math.max(...got) : 1;
    if (hi - lo < 1e-9) { lo -= 0.5; hi += 0.5; }
    const X = (i) => 50 + i * 940 / Math.max(steps.length - 1, 1), Y = (x) => 180 - (x - lo) / (hi - lo) * 160;
    let d = "", dots = "";
    vals.forEach((x, i) => {
      if (x === undefined || Number.isNaN(x)) return;
      d += `${d ? "L" : "M"}${X(i).toFixed(1)},${Y(x).toFixed(1)}`;
      dots += `<circle cx="${X(i).toFixed(1)}" cy="${Y(x).toFixed(1)}" r="2.5" fill="var(--accent)"/>`;
    });
    const fg = getComputedStyle(document.body).color, u = A.unit ? " " + A.unit : "";
    const ci = steps.indexOf(t0);
    svg.innerHTML =
      `<line x1="50" y1="180" x2="990" y2="180" stroke="${fg}" stroke-opacity=".25"/>` +
      (ci >= 0 ? `<line x1="${X(ci)}" y1="20" x2="${X(ci)}" y2="180" stroke="${fg}" stroke-opacity=".25" stroke-dasharray="4 3"/>` : "") +
      `<text x="4" y="24" font-size="12" fill="${fg}">${+hi.toPrecision(4)}${u}</text>` +
      `<text x="4" y="180" font-size="12" fill="${fg}">${+lo.toPrecision(4)}${u}</text>` +
      `<text x="50" y="196" font-size="12" fill="${fg}" opacity=".7">${T.label(steps[0])}</text>` +
      `<text x="990" y="196" font-size="12" fill="${fg}" opacity=".7" text-anchor="end">${T.label(steps[steps.length - 1])}</text>` +
      `<text x="520" y="14" font-size="12" fill="${fg}" text-anchor="middle">${A.name}` +
      (lonlat ? ` at ${lonlat[0].toFixed(3)}, ${lonlat[1].toFixed(3)}` : "") + `: ${done} of ${steps.length} steps</text>` +
      `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="1.5" vector-effect="non-scaling-stroke"/>` + dots;
    $("sstat").textContent = `${done} sources opened, ${req} range requests, ${mb(bytes)} MB`;
  };
  // one source's grid, to find the cell: the current slice's COG
  const hit = sourcesAt(A, [t0]).pop();
  if (!hit?.source.url) return;
  const info = JSON.parse((await cogFor(hit.source.url)).info());
  const scrs = info.crs ?? "EPSG:4326", gt = info.geotransform;
  let sx, sy;
  try {
    const tr = new Transform(crs, scrs);
    [sx, sy] = tr.forward(viewXY);
    tr.free();
  } catch (e) { say(String(e.message || e), true); return; }
  const col = Math.floor((sx - gt[0]) / gt[1]), row = Math.floor((sy - gt[3]) / gt[5]);
  if (!(col >= 0 && row >= 0 && col < info.width && row < info.height)) return;
  // the cell's own extent, warped 1 x 1 with nearest: exactly that pixel
  const xa = gt[0] + col * gt[1], ya = gt[3] + row * gt[5];
  const cell = [Math.min(xa, xa + gt[1]), Math.max(xa, xa + gt[1]), Math.min(ya, ya + gt[5]), Math.max(ya, ya + gt[5])];
  lonlat = [(cell[0] + cell[1]) / 2, (cell[2] + cell[3]) / 2];
  plot();
  let next = 0;
  async function worker() {
    while (next < steps.length && my === stoken) {
      const k = next++, s = sourcesAt(A, [steps[k]]).pop()?.source;
      if (!s?.url) { vals[k] = NaN; done++; continue; }
      let cog = null;
      try {
        cog = await Cog.open(s.url);
        const out = await cog.warp(scrs, cell, 1, 1, "near");
        vals[k] = physical(A, out.values.subarray(s.band - 1, s.band))[0];
        req += out.requests; bytes += out.bytes;
      } catch (e) {
        vals[k] = NaN;
      } finally {
        cog?.free();
      }
      done++;
      if (my === stoken) plot();
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
}

// ---- controls --------------------------------------------------------------

for (const [k, p] of Object.entries(PROJS)) $("proj").add(new Option(p.name, k));
$("proj").onchange = () => { const p = PROJS[$("proj").value]; crs = p.crs; extent = fitAspect(p.extent); render(); };
$("resampling").onchange = () => render();
$("array").onchange = () => chooseArray();
$("t").addEventListener("input", () => { $("tlabel").textContent = `${T.label(+$("t").value)} (${T.name} ${$("t").value} of ${T.size})`; });
$("t").addEventListener("change", () => render());
const step = (d) => { const r = $("t"); r.value = Math.min(+r.max, Math.max(0, +r.value + d)); render(); };
$("prev").onclick = () => step(-1);
$("next").onclick = () => step(1);
$("load").onclick = () => loadVrt($("vrt").value.trim());
for (const id of ["vmin", "vmax"]) {
  $(id).onchange = () => {
    range = [+$("vmin").value, +$("vmax").value];
    if (last) draw(last.vals, last.w, last.h);
  };
}
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); step(e.key === "ArrowLeft" ? -1 : 1); }
});

// pan, zoom, hover and click
const toView = (e) => {
  const r = canvas.getBoundingClientRect();
  const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
  return { fx, fy, x: extent[0] + fx * (extent[1] - extent[0]), y: extent[3] - fy * (extent[3] - extent[2]) };
};
let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const tip = $("tip");
  if (drag) {
    const dpx = e.clientX - drag.x, dpy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dpx, dpy) < 4) return;
    drag.moved = true;
    canvas.classList.add("dragging");
    tip.style.display = "none";
    const s = (extent[1] - extent[0]) / canvas.getBoundingClientRect().width;
    drag.x = e.clientX; drag.y = e.clientY;
    extent = [extent[0] - dpx * s, extent[1] - dpx * s, extent[2] + dpy * s, extent[3] + dpy * s];
    render(true);
    return;
  }
  if (!last) { tip.style.display = "none"; return; }
  const { fx, fy } = toView(e);
  const i = Math.floor(fy * last.h) * last.w + Math.floor(fx * last.w);
  const v = last.vals[i];
  tip.textContent = Number.isFinite(v) ? `${+v.toPrecision(5)}${A.unit ? " " + A.unit : ""}` : "nodata";
  const b = canvas.parentElement.getBoundingClientRect();
  tip.style.left = `${e.clientX - b.left + 12}px`;
  tip.style.top = `${e.clientY - b.top + 12}px`;
  tip.style.display = "block";
});
canvas.addEventListener("pointerleave", () => { $("tip").style.display = "none"; });
const endDrag = (e) => {
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  canvas.classList.remove("dragging");
  if (moved) render();
  else if (e.type === "pointerup") { const p = toView(e); series([p.x, p.y]); }
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
let wheelTimer = null;
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const { fx, fy, x, y } = toView(e);
  const k = Math.exp(e.deltaY * 0.0015);
  const w = (extent[1] - extent[0]) * k, h = (extent[3] - extent[2]) * k;
  extent = [x - fx * w, x + (1 - fx) * w, y - (1 - fy) * h, y + fy * h];
  render(true);
  clearTimeout(wheelTimer);
  wheelTimer = setTimeout(() => render(), 200);
}, { passive: false });

// Start: ?vrt=, ?array=, ?t=, ?proj= override the defaults.
await init();
const q = new URLSearchParams(location.search);
if (q.get("proj") && PROJS[q.get("proj")]) $("proj").value = q.get("proj");
{ const p = PROJS[$("proj").value]; crs = p.crs; extent = fitAspect(p.extent); }
$("vrt").value = q.get("vrt") ?? DEFAULT_VRT;
await loadVrt($("vrt").value);
