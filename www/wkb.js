// Well-known binary to GeoJSON geometry, for the geometry column of a
// GeoParquet file read without DuckDB's spatial extension. ISO WKB and
// EWKB, either byte order; Z and M values are read and dropped.

export function wkbToGeoJSON(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;

  function geometry() {
    const le = view.getUint8(pos) === 1;
    pos += 1;
    let code = view.getUint32(pos, le);
    pos += 4;
    // EWKB flags in the high bits, ISO dimensions in the thousands
    let dims = 2;
    if (code & 0x80000000) dims += 1;
    if (code & 0x40000000) dims += 1;
    if (code & 0x20000000) pos += 4; // SRID
    code &= 0x0fffffff;
    const iso = Math.floor(code / 1000);
    if (iso === 1 || iso === 2) dims = 3;
    if (iso === 3) dims = 4;
    const type = code % 1000;

    const u32 = () => {
      const v = view.getUint32(pos, le);
      pos += 4;
      return v;
    };
    const point = () => {
      const x = view.getFloat64(pos, le);
      const y = view.getFloat64(pos + 8, le);
      pos += 8 * dims;
      return [x, y];
    };
    const points = () => {
      const n = u32();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = point();
      return out;
    };
    const rings = () => {
      const n = u32();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = points();
      return out;
    };
    const parts = () => {
      const n = u32();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = geometry();
      return out;
    };

    switch (type) {
      case 1: {
        const c = point();
        return Number.isNaN(c[0]) ? null : { type: "Point", coordinates: c };
      }
      case 2: return { type: "LineString", coordinates: points() };
      case 3: return { type: "Polygon", coordinates: rings() };
      case 4: return { type: "MultiPoint", coordinates: parts().filter(Boolean).map((g) => g.coordinates) };
      case 5: return { type: "MultiLineString", coordinates: parts().map((g) => g.coordinates) };
      case 6: return { type: "MultiPolygon", coordinates: parts().map((g) => g.coordinates) };
      case 7: return { type: "GeometryCollection", geometries: parts().filter(Boolean) };
      default: throw new Error(`WKB geometry type ${code} is not supported`);
    }
  }

  return geometry();
}
