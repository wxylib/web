// A reader for GDAL multidimensional VRT (mdim.vrt) in plain JavaScript.
//
// parseMdimVrt(text, baseUrl) turns the XML into groups, dimensions and
// arrays, each array with its coordinate values (RegularlySpacedValues or
// InlineValues), type, unit, nodata, scale and offset, attributes, and its
// sources: the file, the band or array in it, the transpose, the source
// slab and the destination offset. sourceAt(array, index) then answers the
// question every read starts with: which source holds this element.
//
// The XML elements follow https://gdal.org/drivers/raster/vrt_multidimensional.html.
// Only the part a reader needs to find bytes is interpreted; anything else
// is kept as text in `extra` so the page can show it.

const num = (s) => (s == null || s === "" ? null : Number(s));
const nums = (s) => (s == null ? null : s.split(",").map((x) => Number(x.trim())));
const kids = (el, tag) => Array.from(el.children).filter((c) => c.tagName === tag);
const kid = (el, tag) => kids(el, tag)[0] ?? null;
const text = (el, tag) => kid(el, tag)?.textContent.trim() ?? null;

// /vsicurl/https://... and friends to a URL fetch() can read, or null.
export function vsiToUrl(name, baseUrl, relative) {
  let s = name.trim();
  for (const p of ["/vsicurl_streaming/", "/vsicurl/"]) if (s.startsWith(p)) s = s.slice(p.length);
  if (/^https?:\/\//.test(s)) return s;
  const s3 = s.match(/^\/vsis3\/([^/]+)\/(.*)$/);
  if (s3) return `https://${s3[1]}.s3.amazonaws.com/${s3[2]}`;
  const gs = s.match(/^\/vsigs\/([^/]+)\/(.*)$/);
  if (gs) return `https://storage.googleapis.com/${gs[1]}/${gs[2]}`;
  if (s.startsWith("/vsi")) return null; // a VSI handler the browser has no route to
  if (relative && baseUrl) return new URL(s, baseUrl).href;
  return null;
}

function attributes(el) {
  const out = {};
  for (const a of kids(el, "Attribute")) {
    const vals = kids(a, "Value").map((v) => v.textContent);
    const dt = text(a, "DataType");
    const conv = dt && dt !== "String" ? vals.map(Number) : vals;
    out[a.getAttribute("name")] = conv.length === 1 ? conv[0] : conv;
  }
  return out;
}

function parseSource(el, baseUrl) {
  const f = kid(el, "SourceFilename");
  const file = f?.textContent.trim() ?? "";
  const relative = f?.getAttribute("relativeToVRT") === "1";
  const slab = kid(el, "SourceSlab");
  const dest = kid(el, "DestSlab");
  return {
    kind: el.tagName,
    file,
    url: vsiToUrl(file, baseUrl, relative),
    band: num(text(el, "SourceBand")),
    array: text(el, "SourceArray"),
    transpose: nums(text(el, "SourceTranspose")),
    view: text(el, "SourceView"),
    srcOffset: nums(slab?.getAttribute("offset")),
    srcCount: nums(slab?.getAttribute("count")),
    srcStep: nums(slab?.getAttribute("step")),
    destOffset: nums(dest?.getAttribute("offset")),
  };
}

function parseArray(el, baseUrl) {
  const a = {
    name: el.getAttribute("name"),
    dtype: text(el, "DataType"),
    dims: kids(el, "DimensionRef").map((d) => d.getAttribute("ref")),
    blockSize: nums(text(el, "BlockSize")),
    srs: text(el, "SRS"),
    unit: text(el, "Unit"),
    nodata: num(text(el, "NoDataValue")),
    offset: num(text(el, "Offset")),
    scale: num(text(el, "Scale")),
    attrs: attributes(el),
    values: null,
    sources: [],
  };
  const reg = kid(el, "RegularlySpacedValues");
  if (reg) a.values = { kind: "regular", start: Number(reg.getAttribute("start")), increment: Number(reg.getAttribute("increment")) };
  const inl = kid(el, "InlineValues") ?? kid(el, "InlineValuesWithValueElement");
  if (inl) {
    const vs = kids(inl, "Value");
    const raw = vs.length ? vs.map((v) => v.textContent) : inl.textContent.trim().split(/[\s,]+/);
    a.values = { kind: "inline", values: a.dtype === "String" ? raw : raw.map(Number) };
  }
  for (const s of Array.from(el.children)) {
    if (s.tagName === "Source" || s.tagName === "ConstantValue") a.sources.push(parseSource(s, baseUrl));
  }
  return a;
}

function parseGroup(el, path, baseUrl) {
  const g = {
    name: el.getAttribute("name"),
    path,
    dims: kids(el, "Dimension").map((d) => ({
      name: d.getAttribute("name"),
      size: Number(d.getAttribute("size")),
      type: d.getAttribute("type"),
      direction: d.getAttribute("direction"),
      indexingVariable: d.getAttribute("indexingVariable"),
    })),
    attrs: attributes(el),
    arrays: kids(el, "Array").map((a) => parseArray(a, baseUrl)),
    groups: [],
  };
  g.groups = kids(el, "Group").map((c) => parseGroup(c, (path === "/" ? "" : path) + "/" + c.getAttribute("name"), baseUrl));
  return g;
}

export function parseMdimVrt(textXml, baseUrl, DOMParserImpl = globalThis.DOMParser) {
  const doc = new DOMParserImpl().parseFromString(textXml, "application/xml");
  const err = doc.getElementsByTagName("parsererror")[0];
  if (err) throw new Error("Not valid XML: " + err.textContent.slice(0, 200));
  const root = doc.documentElement;
  if (root.tagName !== "VRTDataset") throw new Error(`Root element is <${root.tagName}>, not <VRTDataset>`);
  const top = kid(root, "Group");
  if (!top) throw new Error("No <Group>: this is a classic (2D) VRT, not a multidimensional one");
  const vrt = { root: parseGroup(top, "/", baseUrl) };
  // resolve every array's dimensions to { name, size, ... } through the group tree
  const walk = (g, scope) => {
    const here = new Map(scope);
    for (const d of g.dims) { here.set(d.name, d); here.set((g.path === "/" ? "" : g.path) + "/" + d.name, d); }
    for (const a of g.arrays) {
      a.group = g.path;
      a.shape = a.dims.map((r) => here.get(r)?.size ?? here.get(r.replace(/^.*\//, ""))?.size ?? null);
      a.dimInfo = a.dims.map((r) => here.get(r) ?? here.get(r.replace(/^.*\//, "")) ?? { name: r });
    }
    for (const c of g.groups) walk(c, here);
  };
  walk(vrt.root, new Map());
  return vrt;
}

export function allArrays(vrt) {
  const out = [];
  const walk = (g) => { out.push(...g.arrays); g.groups.forEach(walk); };
  walk(vrt.root);
  return out;
}

// The destination box a source fills: [start, end) per destination axis,
// or null on an axis whose extent depends on opening the source (no
// SourceSlab count). A -1 in SourceTranspose is a new axis of length 1.
export function destBox(array, s) {
  const n = array.dims.length;
  const off = s.destOffset ?? new Array(n).fill(0);
  return off.map((o, i) => {
    let c = s.srcCount?.[i] ?? null;
    if (c != null && s.srcStep?.[i] && Math.abs(s.srcStep[i]) !== 1) c = Math.ceil(c / Math.abs(s.srcStep[i]));
    if (c == null && s.transpose && s.transpose[i] === -1) c = 1;
    return [o, c == null ? null : o + c];
  });
}

// The sources of an array with the destination box each fills, in
// document order: [{ source, box }]. Kept on the array after the first call.
export function indexSources(array) {
  const list = array.sources.filter((s) => s.kind === "Source").map((source) => ({ source, box: destBox(array, source) }));
  array.index = list;
  return list;
}

// The sources covering destination element `idx` (an array of indices;
// trailing axes left out match everything). GDAL applies sources in
// order, so where they overlap the last one is what a read sees.
export function sourcesAt(array, idx) {
  const list = array.index ?? indexSources(array);
  return list.filter(({ box }) =>
    idx.every((v, i) => !box[i] || (v >= box[i][0] && (box[i][1] == null || v < box[i][1]))));
}

// Coordinate value i of a 1D indexing array, or null.
export function coordValue(array, i) {
  const v = array?.values;
  if (!v) return null;
  if (v.kind === "regular") return v.start + i * v.increment;
  return v.values[i] ?? null;
}

// CF time units ("days since 1970-01-01") to a function index -> Date.
export function cfTime(unit) {
  const m = unit?.match(/^\s*(\w+)\s+since\s+(.+?)\s*$/);
  if (!m) return null;
  const per = { days: 864e5, day: 864e5, d: 864e5, hours: 36e5, hour: 36e5, h: 36e5,
                minutes: 6e4, minute: 6e4, seconds: 1e3, second: 1e3, s: 1e3 }[m[1].toLowerCase()];
  if (!per) return null;
  let ref = m[2].replace(" ", "T");
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(ref)) ref += "T00:00:00";
  if (!/[zZ]|[+-]\d\d:?\d\d$/.test(ref)) ref += "Z";
  const t0 = Date.parse(ref);
  if (Number.isNaN(t0)) return null;
  return (v) => new Date(t0 + v * per);
}
