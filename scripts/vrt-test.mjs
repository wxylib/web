// Tests for www/ogrvrt.js against GDAL: node scripts/vrt-test.mjs [cache]
//
// Every example VRT in www/data/vrt is read here and compared, feature by
// feature, with GDAL's reading of it (scripts/vrt-oracle.json, written by
// scripts/vrt_oracle.py). The libraries the page loads from a CDN are
// imported from node_modules: npm install flatgeobuf@4.6.0
// hyparquet@1.31.4 hyparquet-compressors@1.1.2 proj4@2.22.0 (run from a
// directory with them, or set NODE_PATH). Local files are served by a
// fetch stand-in with range requests; remote sources are read from a
// cache directory of the same file names (the optional argument), and
// skipped without it.
import assert from "node:assert/strict";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  parseVRT, readLayer, parseWhere, evaluate, parseWKT, intersects, parseSelect, crsFrom, styleFrom, toLonLat, layerName,
} from "../www/ogrvrt.js";

const here = dirname(fileURLToPath(import.meta.url));
const www = join(here, "..", "www");
const cache = process.argv[2] || null;
const require = createRequire(join(process.cwd(), "x.js"));
const load = async (m) => import(require.resolve(m));
const libs = {
  proj4: (await load("proj4")).default,
  flatgeobuf: await load("flatgeobuf/geojson"),
  hyparquet: await load("hyparquet"),
  compressors: (await load("hyparquet-compressors")).compressors,
};

const LOCAL = "http://local.test/";
function pathFor(url) {
  if (url.startsWith(LOCAL)) return join(www, decodeURIComponent(url.slice(LOCAL.length)));
  if (cache) return join(cache, basename(new URL(url).pathname));
  return null;
}
let requests = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input.url || input);
  const p = pathFor(url);
  if (!p || !existsSync(p)) throw new Error(`offline: ${url}`);
  requests++;
  const size = statSync(p).size;
  const h = new Headers(init.headers || (input.headers || {}));
  const headers = { "Content-Length": String(size), "Accept-Ranges": "bytes" };
  if ((init.method || "GET") === "HEAD") return new Response(null, { status: 200, headers });
  const range = h.get("Range");
  const buf = readFileSync(p);
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const a = +m[1], b = m[2] ? Math.min(+m[2], size - 1) : size - 1;
    return new Response(buf.subarray(a, b + 1), { status: 206, headers: {
      "Content-Range": `bytes ${a}-${b}/${size}`, "Content-Length": String(b - a + 1) } });
  }
  return new Response(buf, { status: 200, headers });
};

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log("ok", name); };
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} != ${b}`);
function sameCoords(a, b, tol, what) {
  if (typeof a === "number") return near(a, b, tol, what);
  assert.equal(a.length, b.length, `${what}: ${a.length} coordinates, GDAL ${b.length}`);
  for (let i = 0; i < a.length; i++) sameCoords(a[i], b[i], tol, what);
}

await test("XML: entities, comments, self-closing", () => {
  const { layers, notes } = parseVRT(`<?xml version="1.0"?><!-- c --><OGRVRTDataSource>
    <OGRVRTLayer name="a"><SrcDataSource>x.csv</SrcDataSource><SrcSQL>SELECT * FROM x WHERE a &lt;&gt; 'b&amp;c'</SrcSQL>
    <GeometryField encoding="PointFromColumns" x="lon" y="lat"/><Bogus/></OGRVRTLayer></OGRVRTDataSource>`, LOCAL);
  assert.equal(layers[0].sql, "SELECT * FROM x WHERE a <> 'b&c'");
  assert.equal(layers[0].geom.encoding, "pointfromcolumns");
  assert.match(notes[0], /Bogus/);
});

await test("OGR SQL WHERE", () => {
  const row = { NAME: "Fiji", POP: 889953, s: "12", n: null };
  const t = (e) => evaluate(parseWhere(e), row);
  assert.equal(t("name = 'Fiji' AND pop > 1000"), true);
  assert.equal(t("NAME IN ('Tonga', 'Fiji')"), true);
  assert.equal(t("NAME NOT IN ('Tonga', 'Fiji')"), false);
  assert.equal(t("NAME LIKE 'F%'"), true);
  assert.equal(t("NAME LIKE 'f%'"), false);
  assert.equal(t("NAME ILIKE 'f_ji'"), true);
  assert.equal(t("s > 9"), true); // a CSV string compared as a number
  assert.equal(t("n IS NULL AND NOT (pop BETWEEN 1 AND 10)"), true);
  assert.equal(t("n = 1 OR pop = 889953"), true);
  assert.equal(t("n = 1"), null);
  const q = parseSelect(`SELECT NAME AS n, POP FROM "my-layer" WHERE POP > 1 ORDER BY POP DESC LIMIT 5 OFFSET 1`);
  assert.deepEqual(q.columns, [{ name: "NAME", alias: "n" }, { name: "POP", alias: "POP" }]);
  assert.equal(q.from, "my-layer");
  assert.equal(q.limit, 5);
});

await test("WKT", () => {
  assert.deepEqual(parseWKT("POINT (1 2)"), { type: "Point", coordinates: [1, 2] });
  assert.deepEqual(parseWKT("POINT Z (1 2 3)").coordinates, [1, 2, 3]);
  assert.deepEqual(parseWKT("POINT M (1 2 9)").coordinates, [1, 2]);
  assert.deepEqual(parseWKT("MULTIPOINT ((1 2), (3 4))").coordinates, [[1, 2], [3, 4]]);
  assert.deepEqual(parseWKT("MULTIPOINT (1 2, 3 4)").coordinates, [[1, 2], [3, 4]]);
  assert.equal(parseWKT("MULTIPOLYGON (((0 0, 1 0, 1 1, 0 0)), ((5 5, 6 5, 6 6, 5 5)))").coordinates.length, 2);
  assert.equal(parseWKT("GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))").geometries.length, 2);
  assert.equal(parseWKT("POLYGON EMPTY"), null);
  assert.deepEqual(parseWKT("SRID=4326;POINT(1 2)").coordinates, [1, 2]);
});

await test("intersects", () => {
  const sq = parseWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0))");
  assert.equal(intersects(parseWKT("POINT (5 5)"), sq), true);
  assert.equal(intersects(parseWKT("POINT (15 5)"), sq), false);
  assert.equal(intersects(parseWKT("LINESTRING (-5 5, 15 5)"), sq), true);
  assert.equal(intersects(parseWKT("POLYGON ((2 2, 3 2, 3 3, 2 2))"), sq), true); // inside
  assert.equal(intersects(sq, parseWKT("POLYGON ((2 2, 3 2, 3 3, 2 2))")), true); // contains
  assert.equal(intersects(parseWKT("POLYGON ((11 11, 12 11, 12 12, 11 11))"), sq), false);
  const holed = parseWKT("POLYGON ((0 0, 10 0, 10 10, 0 10, 0 0), (2 2, 8 2, 8 8, 2 8, 2 2))");
  assert.equal(intersects(parseWKT("POINT (5 5)"), holed), false);
});

await test("CRS input", () => {
  assert.equal(crsFrom("WGS84").lonlat, true);
  assert.equal(crsFrom("urn:ogc:def:crs:EPSG::3031").label, "EPSG:3031");
  assert.match(crsFrom("EPSG:32755").def, /zone=55 \+south/);
  assert.equal(crsFrom("NULL"), null);
  assert.throws(() => crsFrom("EPSG:2154"), /short list/);
  assert.equal(crsFrom({ id: { authority: "EPSG", code: 3857 } }).label, "EPSG:3857");
});

await test("OGR style strings", () => {
  assert.deepEqual(styleFrom("PEN(c:#FF0000,w:2px,p:\"4px 2px\");BRUSH(fc:#00FF0080)"),
    { color: "#FF0000", opacity: 1, weight: 2, dashArray: "4 2", fillColor: "#00FF00", fillOpacity: 128 / 255 });
});

// Against GDAL
const oracle = JSON.parse(readFileSync(join(here, "vrt-oracle.json"), "utf8"));
for (const [file, want] of Object.entries(oracle)) {
  const text = readFileSync(join(www, "data", "vrt", file), "utf8");
  const remote = /https:\/\//.test(text);
  if (remote && !cache) { console.log("skip", file, "(remote source; pass a cache directory)"); continue; }
  await test(`${file} as GDAL reads it`, async () => {
    const { layers } = parseVRT(text, `${LOCAL}data/vrt/${file}`);
    assert.deepEqual(layers.map(layerName), Object.keys(want.layers));
    for (const spec of layers) {
      const name = layerName(spec);
      const gdal = want.layers[name];
      const got = await readLayer(spec, { libs, view: want.bbox, cache: new Map() });
      assert.deepEqual(got.fields.map((f) => f.name), gdal.fields, `${name} fields`);
      assert.equal(got.srs ? got.srs.label : null, gdal.crs, `${name} CRS`);
      assert.equal(got.features.length, gdal.features.length, `${name}: ${got.features.length} features, GDAL ${gdal.features.length}`);
      // FlatGeobuf comes back in index order; match by FID.
      const byFid = new Map(got.features.map((f) => [f.fid, f]));
      gdal.features.forEach((g, i) => {
        const f = got.byView ? byFid.get(g.fid) : got.features[i];
        assert.ok(f, `${name}: no feature with FID ${g.fid}`);
        if (g.fid !== null && g.fid !== undefined) assert.equal(f.fid, g.fid, `${name} FID`);
        assert.deepEqual(f.properties, g.properties, `${name} feature ${i}`);
        if (g.geometry === null) assert.equal(f.geometry, null);
        else {
          assert.equal(f.geometry.type, g.geometry.type, `${name} feature ${i} type`);
          sameCoords(f.geometry.coordinates, g.geometry.coordinates, got.srs && got.srs.lonlat ? 1e-7 : 1e-3, `${name} feature ${i}`);
        }
      });
      toLonLat(got, libs.proj4);
    }
  });
}
console.log(`${n} tests passed, ${requests} reads`);
