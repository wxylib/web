// BRAN2023 temp straight from a byte-reference table: each chunk is one
// range request into a netCDF file on THREDDS, inflated (zlib) and
// unshuffled (2-byte HDF5 shuffle) here. The table is a cut of the store's
// flat mdim-refs export (scripts/bran_extract.py); ?refs= names another.

const params = new URLSearchParams(location.search);
const REFS = params.get("refs") || "data/bran2023-temp-2010.json";
const VMIN = -2, VMAX = 31;
const $ = (id) => document.getElementById(id);

let T;                      // the refs extract
const cache = new Map();    // chunk key -> Int16Array
const stats = { req: 0, bytes: 0 };
let token = 0;              // the newest frame; older ones stop drawing
let stoken = 0;             // the newest series

const lut = new Uint8Array(INFERNO);
const nlut = lut.length / 3;

async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function unshuffle(b) {
  const n = b.length / 2, out = new Uint8Array(b.length);
  for (let i = 0; i < n; i++) { out[2 * i] = b[i]; out[2 * i + 1] = b[n + i]; }
  return new Int16Array(out.buffer);
}

// One chunk: level li, day t, chunk row cy, chunk column cx.
async function chunk(li, t, cy, cx) {
  const key = `${li}/${t}/${cy}/${cx}`;
  if (cache.has(key)) return cache.get(key);
  const L = T.levels[li], [, ny, nx] = T.chunk_grid;
  const i = (t * ny + cy) * nx + cx;
  const off = L.offset[i], size = L.size[i];
  let r, tries = 0;
  for (;;) {
    try {
      r = await fetch(T.files[L.file[t]], { headers: { Range: `bytes=${off}-${off + size - 1}` } });
      if (r.status !== 206) throw new Error(`HTTP ${r.status}`);
      break;
    } catch (e) {
      if (++tries > 3) throw e;
      await new Promise((ok) => setTimeout(ok, 500 * 2 ** tries));
    }
  }
  const buf = await r.arrayBuffer();
  stats.req++; stats.bytes += buf.byteLength;
  const v = unshuffle(await inflate(buf));
  cache.set(key, v);
  return v;
}

function showStats() {
  $("s-req").textContent = stats.req.toLocaleString();
  $("s-mb").textContent = (stats.bytes / 1e6).toFixed(1);
}

const degc = (raw) => (raw === T.fill ? NaN : raw * T.scale_factor + T.add_offset);

// Draw one chunk into the canvas: north up, so chunk rows flip.
function paint(ctx, v, cy, cx) {
  const [, , h, w] = T.chunks, img = ctx.createImageData(w, h);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const raw = v[r * w + c], o = ((h - 1 - r) * w + c) * 4;
      if (raw === T.fill) { img.data[o + 3] = 0; continue; }
      const t = (degc(raw) - VMIN) / (VMAX - VMIN);
      const k = Math.max(0, Math.min(nlut - 1, Math.round(t * (nlut - 1)))) * 3;
      img.data[o] = lut[k]; img.data[o + 1] = lut[k + 1]; img.data[o + 2] = lut[k + 2]; img.data[o + 3] = 255;
    }
  }
  const H = T.shape[2];
  ctx.putImageData(img, cx * w, H - (cy + 1) * h);
  if ($("grid").checked) {
    ctx.strokeStyle = "rgba(127,127,127,.6)"; ctx.lineWidth = 2;
    ctx.strokeRect(cx * w + 1, H - (cy + 1) * h + 1, w - 2, h - 2);
  }
}

// The whole globe for a day and level, centre chunks first, several in flight.
async function frame() {
  const my = ++token, t0 = performance.now();
  const li = +$("level").value, t = +$("day").value;
  $("date").textContent = dateOf(t);
  const ctx = $("map").getContext("2d");
  const [, ny, nx] = T.chunk_grid;
  const L = T.levels[li];
  const jobs = [];
  for (let cy = 0; cy < ny; cy++) for (let cx = 0; cx < nx; cx++) jobs.push([cy, cx]);
  jobs.sort((a, b) => Math.hypot(a[0] - ny / 2, a[1] - nx / 2) - Math.hypot(b[0] - ny / 2, b[1] - nx / 2));
  let held = 0;
  for (const [cy, cx] of jobs) held += L.size[(t * ny + cy) * nx + cx];
  $("s-ref").textContent = (held / 1e6).toFixed(1);
  let next = 0;
  async function worker() {
    while (next < jobs.length && my === token) {
      const [cy, cx] = jobs[next++];
      const v = await chunk(li, t, cy, cx);
      if (my !== token) return;
      paint(ctx, v, cy, cx);
      showStats();
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  if (my === token) $("s-ms").textContent = ((performance.now() - t0) / 1000).toFixed(1);
  return my === token;
}

function dateOf(t) {
  const days = T.time.start + T.time.step * t;          // days since the epoch in units
  const epoch = Date.parse(T.time.units.replace(/^days since /, "").replace(" ", "T") + "Z");
  return new Date(epoch + days * 864e5).toISOString().slice(0, 10);
}

// Map pixel -> grid cell (column, row from the south), or null off the grid.
function cellAt(ev) {
  const c = $("map"), b = c.getBoundingClientRect();
  const col = Math.floor((ev.clientX - b.left) / b.width * T.shape[3]);
  const row = T.shape[2] - 1 - Math.floor((ev.clientY - b.top) / b.height * T.shape[2]);
  if (col < 0 || row < 0 || col >= T.shape[3] || row >= T.shape[2]) return null;
  return { col, row, lon: T.x.start + col * T.x.step, lat: T.y.start + row * T.y.step };
}

function valueAt(li, t, p) {
  const [, , h, w] = T.chunks, v = cache.get(`${li}/${t}/${Math.floor(p.row / h)}/${Math.floor(p.col / w)}`);
  return v ? degc(v[(p.row % h) * w + (p.col % w)]) : undefined;
}

// A year at one cell: one chunk per day, drawn as it arrives.
async function series(p) {
  const my = ++stoken, li = +$("level").value, [, , h, w] = T.chunks;
  const cy = Math.floor(p.row / h), cx = Math.floor(p.col / w);
  const n = T.shape[0], vals = new Array(n).fill(undefined);
  const svg = $("series");
  const draw = () => {
    const got = vals.filter((x) => x !== undefined && !isNaN(x));
    const lo = got.length ? Math.floor(Math.min(...got)) : 0, hi = got.length ? Math.ceil(Math.max(...got)) : 1;
    const X = (i) => 40 + i * 950 / (n - 1), Y = (x) => 200 - (x - lo) / Math.max(hi - lo, 1) * 180;
    let d = "";
    vals.forEach((x, i) => { if (x !== undefined && !isNaN(x)) d += `${d ? "L" : "M"}${X(i).toFixed(1)},${Y(x).toFixed(1)}`; });
    const fg = getComputedStyle(document.body).color;
    svg.innerHTML =
      `<line x1="40" y1="200" x2="990" y2="200" stroke="${fg}" stroke-opacity=".25"/>` +
      `<text x="4" y="24" font-size="12" fill="${fg}">${hi} C</text><text x="4" y="200" font-size="12" fill="${fg}">${lo} C</text>` +
      `<text x="44" y="216" font-size="12" fill="${fg}" opacity=".7">${dateOf(0)}</text>` +
      `<text x="990" y="216" font-size="12" fill="${fg}" opacity=".7" text-anchor="end">${dateOf(n - 1)}</text>` +
      `<text x="520" y="16" font-size="12" fill="${fg}" text-anchor="middle">${p.lon.toFixed(2)}E ${p.lat.toFixed(2)}N, ${T.levels[li].depth} m: ` +
      `${got.length} of ${n} days</text>` +
      `<path d="${d}" fill="none" stroke="var(--accent)" stroke-width="2" vector-effect="non-scaling-stroke"/>`;
  };
  let next = 0;
  async function worker() {
    while (next < n && my === stoken) {
      const t = next++;
      const v = await chunk(li, t, cy, cx);
      vals[t] = degc(v[(p.row % h) * w + (p.col % w)]);
      showStats();
      if (t % 10 === 0) draw();
    }
  }
  await Promise.all(Array.from({ length: 8 }, worker));
  draw();
}

let playing = false;
async function play() {
  playing = !playing;
  $("play").textContent = playing ? "Stop" : "Play";
  while (playing) {
    const d = $("day");
    d.value = (+d.value + 1) % T.shape[0];
    if (!(await frame())) break;
  }
}

async function main() {
  $("src").textContent = new URL(REFS, location.href).href;
  T = await (await fetch(REFS)).json();
  $("about").textContent = `${T.about}. Table cut from ${T.store}; ${T.files.length} source files, ` +
    `${T.levels.reduce((s, L) => s + L.offset.length, 0).toLocaleString()} chunk references.`;
  T.levels.forEach((L, i) => $("level").add(new Option(`${L.depth} m`, i)));
  $("day").max = T.shape[0] - 1;
  for (const id of ["day", "level", "grid"]) $(id).addEventListener("change", frame);
  $("day").addEventListener("input", () => { $("date").textContent = dateOf(+$("day").value); });
  $("play").addEventListener("click", play);
  const tip = $("tip");
  $("map").addEventListener("mousemove", (ev) => {
    const p = cellAt(ev);
    if (!p) { tip.style.display = "none"; return; }
    const v = valueAt(+$("level").value, +$("day").value, p);
    tip.textContent = `${p.lon.toFixed(2)}E ${p.lat.toFixed(2)}N  ` +
      (v === undefined ? "not loaded" : isNaN(v) ? "land" : `${v.toFixed(2)} C`);
    const b = $("map").parentElement.getBoundingClientRect();
    tip.style.left = `${ev.clientX - b.left + 12}px`; tip.style.top = `${ev.clientY - b.top + 12}px`;
    tip.style.display = "block";
  });
  $("map").addEventListener("mouseleave", () => { tip.style.display = "none"; });
  $("map").addEventListener("click", (ev) => { const p = cellAt(ev); if (p) series(p); });
  await frame();
  const at = params.get("at");                          // ?at=lon,lat opens a series
  if (at) {
    const [lon, lat] = at.split(",").map(Number);
    const col = Math.round((lon - T.x.start) / T.x.step), row = Math.round((lat - T.y.start) / T.y.step);
    series({ col, row, lon: T.x.start + col * T.x.step, lat: T.y.start + row * T.y.step });
  }
}

main().catch((e) => { $("about").textContent = `Failed: ${e.message}`; console.error(e); });
