// Read what a view plan needs from a Zarr store: for each resolution
// level a geotransform, a size and a chunk shape, and the CRS. Metadata
// only (zarr.json files); no chunk is read.
//
// Understood: a Zarr v3 array with the GeoZarr `spatial:` and `proj:`
// attributes (on the array, or on the group above it), and a group with
// `multiscales` in the zarr-conventions layout form: a list of items,
// each naming an array (`asset`) and optionally carrying its own
// `spatial:transform` or a `transform.scale` relative to the first item.

const BYTES = { int8: 1, uint8: 1, bool: 1, int16: 2, uint16: 2, float16: 2, int32: 4, uint32: 4, float32: 4,
                int64: 8, uint64: 8, float64: 8 };

// `spatial:transform` is [a, b, c, d, e, f] with x = a*col + b*row + c and
// y = d*col + e*row + f; a GDAL geotransform is [c, a, b, f, d, e]. A
// node-registered grid places cell centres: shift half a cell to corners.
export function geotransform(attrs) {
  const t = attrs["spatial:transform"];
  if (!Array.isArray(t) || t.length !== 6 || !t.every(Number.isFinite)) return null;
  const type = attrs["spatial:transform_type"];
  if (type && type !== "affine") return null;
  const gt = [t[2], t[0], t[1], t[5], t[3], t[4]];
  if (attrs["spatial:registration"] === "node") {
    gt[0] -= 0.5 * (gt[1] + gt[2]);
    gt[3] -= 0.5 * (gt[4] + gt[5]);
  }
  return gt;
}

export function crsOf(attrs) {
  if (typeof attrs["proj:code"] === "string") return attrs["proj:code"];
  if (typeof attrs["proj:proj4"] === "string") return attrs["proj:proj4"];
  return null;
}

// One level from an array's metadata. `inherited` is the group's
// attributes; the array's own win. `gt` overrides the transform.
export function levelOf(meta, inherited = {}, gt = null) {
  if (meta.node_type !== "array") throw new Error("not a Zarr array");
  const attrs = { ...inherited, ...(meta.attributes || {}) };
  const shape = meta.shape, chunk = meta.chunk_grid?.configuration?.chunk_shape;
  if (!Array.isArray(shape) || shape.length < 2) throw new Error("the array has fewer than two dimensions");
  if (meta.chunk_grid?.name !== "regular" || !Array.isArray(chunk)) throw new Error("the array's chunk grid is not regular");
  // the spatial dimensions: named by spatial:dimensions as [y, x], else the last two
  const names = meta.dimension_names || [];
  const want = attrs["spatial:dimensions"];
  let iy = shape.length - 2, ix = shape.length - 1;
  if (Array.isArray(want) && want.length === 2 && names.includes(want[0]) && names.includes(want[1])) {
    iy = names.indexOf(want[0]);
    ix = names.indexOf(want[1]);
  }
  gt = gt || geotransform(attrs);
  if (!gt) throw new Error("no affine spatial:transform on the array or its group");
  return { gt, size: [shape[ix], shape[iy]], chunk: [chunk[ix], chunk[iy]],
           lastTwo: iy === shape.length - 2 && ix === shape.length - 1,
           bytesPerCell: BYTES[meta.data_type] ?? null, crs: crsOf(attrs), dtype: String(meta.data_type) };
}

// The first level's geotransform with cells `sx`, `sy` times as large.
function scaled(gt, sx, sy) {
  return [gt[0], gt[1] * sx, gt[2] * sy, gt[3], gt[4] * sx, gt[5] * sy];
}

// Open the store at `url` with `getJson(url)` (resolves to parsed JSON,
// or throws). Resolves to { crs, levels, kind, bytesPerCell, dtype, base,
// paths, lastTwo }: `paths` are the arrays, one a level, under `base`;
// `lastTwo` is whether y and x are every array's last two dimensions.
export async function openZarr(url, getJson) {
  const base = url.replace(/\/+$/, "").replace(/\/zarr\.json$/, "");
  const root = await getJson(base + "/zarr.json");
  if (root.zarr_format !== 3) throw new Error("only Zarr v3 metadata (zarr.json) is read");
  const attrs = root.attributes || {};
  if (root.node_type === "array") {
    // the group above may hold the spatial attributes
    let up = {};
    if (!geotransform(attrs) || !crsOf(attrs)) {
      try { up = (await getJson(base.replace(/\/[^/]+$/, "") + "/zarr.json")).attributes || {}; } catch { up = {}; }
    }
    const l = levelOf(root, up);
    const cut = base.lastIndexOf("/");
    return finish([l], "one array, no overviews", base.slice(0, cut), [base.slice(cut + 1)]);
  }
  const layout = attrs.multiscales?.layout;
  if (!Array.isArray(layout) || !layout.length) {
    throw new Error("a group without multiscales: give the URL of one of its arrays");
  }
  const metas = await Promise.all(layout.map((item) => getJson(`${base}/${item.asset}/zarr.json`)));
  const levels = [];
  for (let i = 0; i < layout.length; i++) {
    const item = layout[i], own = { ...attrs, ...item };
    let gt = geotransform({ ...own, ...(metas[i].attributes || {}) });
    if (!gt && levels.length && Array.isArray(item.transform?.scale)) {
      // relative to the first item, in the order of spatial:dimensions (y, x)
      const s = item.transform.scale, n = s.length;
      gt = scaled(levels[0].gt, s[n - 1], s[n - 2]);
    }
    levels.push(levelOf(metas[i], own, gt));
  }
  return finish(levels, `multiscales, ${levels.length} levels`, base, layout.map((item) => String(item.asset)));
}

function finish(levels, kind, base, paths) {
  const crs = levels.map((l) => l.crs).find(Boolean);
  if (!crs) throw new Error("no proj:code or proj:proj4 on the array or its group");
  return { crs, levels: levels.map(({ gt, size, chunk }) => ({ gt, size, chunk })), kind,
           bytesPerCell: levels[0].bytesPerCell, dtype: levels[0].dtype, base, paths,
           lastTwo: levels.every((l) => l.lastTwo) };
}

// Ten numbers a level, as the wasm planner takes them.
export function flatLevels(levels) {
  return new Float64Array(levels.flatMap((l) => [...l.gt, ...l.size, ...l.chunk]));
}
