// A TIFF header reader in plain JavaScript: image directories only, no
// pixels. For the VRT discovery page: a source's size, bands, data type,
// geotransform, CRS code, nodata, and its block structure (tiles or strips,
// overviews, compression), from one or two range requests.
//
// Classic TIFF and BigTIFF, either byte order. Tag numbers are from the
// TIFF 6.0 and GeoTIFF 1.1 specifications.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };
const COMPRESSION = { 1: "none", 5: "LZW", 7: "JPEG", 8: "Deflate", 32773: "PackBits", 32946: "Deflate", 34887: "LERC", 34925: "LZMA", 50000: "ZSTD", 50001: "WebP", 50002: "JPEG XL" };

// fetch() ranges with a small cache of what has been read.
class Bytes {
  constructor(url, fetchImpl) { this.url = url; this.fetch = fetchImpl; this.parts = []; this.requests = 0; this.bytes = 0; }
  async get(off, len) {
    for (const p of this.parts) if (off >= p.off && off + len <= p.off + p.buf.byteLength) return new DataView(p.buf, off - p.off, len);
    const want = Math.max(len, 65536);
    const r = await this.fetch(this.url, { headers: { Range: `bytes=${off}-${off + want - 1}` } });
    if (!r.ok && r.status !== 206) throw new Error(`HTTP ${r.status} for ${this.url}`);
    const buf = await r.arrayBuffer();
    this.requests += 1; this.bytes += buf.byteLength;
    // a server that ignores Range sends the whole file from 0
    const start = r.status === 206 ? off : 0;
    this.parts.push({ off: start, buf });
    if (off - start + len > buf.byteLength) throw new Error("short read");
    return new DataView(buf, off - start, len);
  }
}

function read(view, type, le, i) {
  switch (type) {
    case 1: case 2: case 7: return view.getUint8(i);
    case 6: return view.getInt8(i);
    case 3: return view.getUint16(i, le);
    case 8: return view.getInt16(i, le);
    case 4: return view.getUint32(i, le);
    case 9: return view.getInt32(i, le);
    case 11: return view.getFloat32(i, le);
    case 12: return view.getFloat64(i, le);
    case 16: return Number(view.getBigUint64(i, le));
    case 17: return Number(view.getBigInt64(i, le));
    case 18: return Number(view.getBigUint64(i, le));
    case 5: return view.getUint32(i, le) / view.getUint32(i + 4, le);
    case 10: return view.getInt32(i, le) / view.getInt32(i + 4, le);
    default: return null;
  }
}

async function tagValues(src, le, big, type, count, valueView, valueAt) {
  const size = (TYPE_SIZE[type] ?? 1) * count;
  const inline = big ? 8 : 4;
  let view = valueView, base = valueAt;
  if (size > inline) {
    const off = big ? Number(valueView.getBigUint64(valueAt, le)) : valueView.getUint32(valueAt, le);
    // offsets and byte counts of many tiles are long: only their length is needed
    if (count > 4096) return { deferred: true, count };
    view = await src.get(off, size); base = 0;
  }
  const out = [];
  for (let k = 0; k < count; k++) out.push(read(view, type, le, base + k * (TYPE_SIZE[type] ?? 1)));
  if (type === 2) return String.fromCharCode(...out).replace(/\0+$/, "");
  return out;
}

async function readIfd(src, le, big, off) {
  const head = await src.get(off, big ? 8 : 2);
  const n = big ? Number(head.getBigUint64(0, le)) : head.getUint16(0, le);
  const entry = big ? 20 : 12;
  const body = await src.get(off + (big ? 8 : 2), n * entry + (big ? 8 : 4));
  const tags = {};
  for (let k = 0; k < n; k++) {
    const e = k * entry;
    const tag = body.getUint16(e, le);
    const type = body.getUint16(e + 2, le);
    const count = big ? Number(body.getBigUint64(e + 4, le)) : body.getUint32(e + 4, le);
    tags[tag] = await tagValues(src, le, big, type, count, body, e + (big ? 12 : 8));
  }
  const next = big ? Number(body.getBigUint64(n * entry, le)) : body.getUint32(n * entry, le);
  return { tags, next };
}

const one = (v) => (Array.isArray(v) ? v[0] : v);
const countOf = (v) => (v == null ? 0 : v.deferred ? v.count : Array.isArray(v) ? v.length : 1);

function dataType(bits, format) {
  const f = format ?? 1;
  if (f === 3) return bits === 64 ? "Float64" : "Float32";
  if (f === 2) return { 8: "Int8", 16: "Int16", 32: "Int32", 64: "Int64" }[bits] ?? `Int${bits}`;
  return { 1: "Byte", 8: "Byte", 16: "UInt16", 32: "UInt32", 64: "UInt64" }[bits] ?? `UInt${bits}`;
}

function geokeys(keys) {
  if (!Array.isArray(keys)) return {};
  const out = {};
  for (let k = 4; k + 3 < keys.length; k += 4) if (keys[k + 1] === 0) out[keys[k]] = keys[k + 3];
  return out;
}

function describe(t) {
  const width = one(t[256]), height = one(t[257]);
  const tiled = t[322] != null;
  const blockX = tiled ? one(t[322]) : width;
  const blockY = tiled ? one(t[323]) : Math.min(one(t[278]) ?? height, height);
  const blocks = [Math.ceil(width / blockX), Math.ceil(height / blockY)];
  const chunks = countOf(tiled ? t[324] : t[273]);
  return {
    width, height,
    bands: one(t[277]) ?? 1,
    dataType: dataType(one(t[258]) ?? 8, one(t[339])),
    compression: COMPRESSION[one(t[259])] ?? `code ${one(t[259])}`,
    predictor: one(t[317]) ?? 1,
    layout: tiled ? "tiles" : "strips",
    block: [blockX, blockY],
    blocks,
    chunks, // tile or strip count as stored (per band when planar)
    planar: one(t[284]) === 2 ? "separate" : "interleaved",
    subfile: one(t[254]) ?? 0,
  };
}

// Open a TIFF at `url` and describe it: the full-resolution image and each
// overview and mask, with geotransform, EPSG code and nodata when present.
export async function readTiffHeader(url, fetchImpl = globalThis.fetch.bind(globalThis)) {
  const src = new Bytes(url, fetchImpl);
  const h = await src.get(0, 16);
  const order = String.fromCharCode(h.getUint8(0), h.getUint8(1));
  if (order !== "II" && order !== "MM") throw new Error("not a TIFF");
  const le = order === "II";
  const magic = h.getUint16(2, le);
  const big = magic === 43;
  if (!big && magic !== 42) throw new Error("not a TIFF");
  let off = big ? Number(h.getBigUint64(8, le)) : h.getUint32(4, le);
  const ifds = [];
  while (off && ifds.length < 64) {
    const { tags, next } = await readIfd(src, le, big, off);
    ifds.push(tags);
    off = next;
  }
  if (!ifds.length) throw new Error("no image directory");
  const t0 = ifds[0];
  const images = ifds.map(describe);
  let geotransform = null;
  const scale = t0[33550], tie = t0[33922], mat = t0[34264];
  if (Array.isArray(mat) && mat.length >= 16) {
    geotransform = [mat[3], mat[0], mat[1], mat[7], mat[4], mat[5]];
  } else if (Array.isArray(scale) && Array.isArray(tie) && tie.length >= 6) {
    const [i, j, , x, y] = tie;
    geotransform = [x - i * scale[0], scale[0], 0, y + j * scale[1], 0, -scale[1]];
  }
  const gk = geokeys(t0[34735]);
  const epsg = gk[3072] ?? gk[2048] ?? null; // projected, then geographic
  const area = gk[1025] === 2 ? "point" : "area";
  const nodata = typeof t0[42113] === "string" ? t0[42113].trim() : null;
  return {
    url,
    format: big ? "BigTIFF" : "TIFF",
    byteOrder: le ? "little" : "big",
    ...images[0],
    geotransform,
    epsg: epsg && epsg !== 32767 ? epsg : null,
    rasterType: area,
    nodata,
    overviews: images.slice(1).filter((im) => !(im.subfile & 4)).map((im) => [im.width, im.height]),
    masks: images.filter((im) => im.subfile & 4).length,
    images,
    requests: src.requests,
    bytes: src.bytes,
  };
}
