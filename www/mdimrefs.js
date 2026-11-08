// Open an mdim-refs/0.2 table export (arrays.json plus refs_<array>.parquet,
// the form wxy-virtual's from_refs_table reads) as the extract bran.js
// draws: per depth level, the file, offset and size of every chunk, in
// (time, chunk row, chunk column) order. Spec: wxylib/design
// specs/mdim-refs-0.2.md. The Parquet is read with hyparquet.

const CDN = "https://cdn.jsdelivr.net/npm";

// The table's `remap` rows for one target, longest prefix first; a path left
// relative resolves against the table's own URL.
function remapper(rules, target, base) {
  const rs = (rules || []).filter((r) => r.target === target)
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return (p) => {
    for (const r of rs) if (p.startsWith(r.prefix)) { p = r.replacement + p.slice(r.prefix.length); break; }
    p = p.replace(/^\/vsicurl\//, "");
    return /^[a-z]+:\/\//.test(p) ? p : new URL(p, base).href;
  };
}

// An axis as {start, step}: affine as stored, inline values by their ends.
function axis(row) {
  if (row.affine) return { start: row.affine.start, step: row.affine.step };
  const v = row.values || [];
  return { start: v[0] ?? 0, step: v.length > 1 ? (v[v.length - 1] - v[0]) / (v.length - 1) : 1 };
}

// dir: the table's URL (ending in /). array: a referenced array, else the
// first. target: a remap target, else the first the table names.
export async function fromMdimRefs(dir, array, target) {
  if (!dir.endsWith("/")) dir += "/";
  const meta = await (await fetch(new URL("arrays.json", dir))).json();
  if (!String(meta.format_version).startsWith("mdim-refs/")) throw new Error(`not an mdim-refs table: ${meta.format_version}`);
  const rows = meta.arrays;
  const data = rows.find((r) => r.storage === "referenced" && (!array || r.array === array));
  if (!data) throw new Error(`no referenced array ${array || ""} in ${dir}arrays.json`);
  if (data.dims.length !== 4) throw new Error(`${data.array}: this page draws 4D arrays (time, level, y, x)`);
  if (data.dtype !== "<i2") throw new Error(`${data.array}: this page draws int16, not ${data.dtype}`);
  const coord = (d) => rows.find((r) => r.storage !== "referenced" && r.dims.length === 1 && r.dims[0] === d) || {};
  const [tdim, zdim, ydim, xdim] = data.dims.map(coord);
  const tgt = target || (meta.remap && meta.remap[0] && meta.remap[0].target);
  const resolve = remapper(meta.remap, tgt, dir);

  const [{ parquetReadObjects, asyncBufferFromUrl }, { compressors }] = await Promise.all([
    import(`${CDN}/hyparquet@1.31.4/+esm`),
    import(`${CDN}/hyparquet-compressors@1.1.2/+esm`),
  ]);
  const url = new URL(`refs_${data.array}.parquet`, dir).href;
  const file = await asyncBufferFromUrl({ url });
  const refs = await parquetReadObjects({
    file, compressors, utf8: false,
    columns: ["dim_0", "dim_1", "dim_2", "dim_3", "present", "path", "offset", "size", "data"],
  });

  const [nt, nz] = data.shape;
  const ny = Math.ceil(data.shape[2] / data.chunks[2]), nx = Math.ceil(data.shape[3] / data.chunks[3]);
  if (data.chunks[0] !== 1 || data.chunks[1] !== 1) throw new Error(`${data.array}: chunks must be one time and one level`);
  const per = nt * ny * nx;
  const files = [], fileIx = new Map(), dec = new TextDecoder();
  const levels = Array.from({ length: nz }, (_, z) => ({
    z, depth: zdim.values ? zdim.values[z] : (zdim.affine ? zdim.affine.start + z * zdim.affine.step : z),
    file: new Int32Array(per).fill(-1), offset: new Float64Array(per), size: new Float64Array(per).fill(0),
    inline: new Map(),
  }));
  for (const r of refs) {
    const [t, z, cy, cx] = [r.dim_0, r.dim_1, r.dim_2, r.dim_3].map(Number);
    if (!Number(r.present)) continue;
    const L = levels[z], i = (t * ny + cy) * nx + cx;
    if (r.offset == null) {                             // inline: the table holds the bytes
      if (r.data) { L.inline.set(i, r.data); L.size[i] = r.data.length; }
      continue;
    }
    const p = resolve(typeof r.path === "string" ? r.path : dec.decode(r.path));
    if (!fileIx.has(p)) { fileIx.set(p, files.length); files.push(p); }
    L.file[i] = fileIx.get(p); L.offset[i] = Number(r.offset); L.size[i] = Number(r.size);
  }

  const a = data.attrs || {};
  const tax = axis(tdim);
  return {
    about: `${data.array} (${a.long_name || a.standard_name || data.array}, ${a.units || ""}) from an mdim-refs table`,
    store: dir, array: data.array, remap_target: tgt || null,
    shape: data.shape, chunks: data.chunks, chunk_grid: [nt, ny, nx],
    dtype: data.dtype, codec: data.codec,
    fill: data.fill == null ? null : Number(data.fill),
    scale_factor: a.scale_factor ?? 1, add_offset: a.add_offset ?? 0, units: a.units || "",
    time: { start: tax.start, step: tax.step, units: (tdim.attrs && tdim.attrs.units) || "days since 1970-01-01" },
    x: axis(xdim), y: axis(ydim), files, levels,
  };
}
