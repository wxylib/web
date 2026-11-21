// Tests of www/zarrmeta.js against the metadata-only stores in
// www/data/zarr and a wxylib/fixtures store. Run: node scripts/zarrmeta-test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openZarr, flatLevels, geotransform, levelOf } from "../www/zarrmeta.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "www", "data", "zarr");
const getJson = async (p) => JSON.parse(await readFile(p, "utf8"));

const pyr = await openZarr(path.join(root, "mur-pyramid.zarr"), getJson);
assert.equal(pyr.crs, "EPSG:4326");
assert.equal(pyr.levels.length, 7);
assert.deepEqual(pyr.levels[0], { gt: [-180, 0.01, 0, 90, 0, -0.01], size: [36000, 18000], chunk: [512, 512] });
assert.deepEqual(pyr.levels[6].size, [563, 282]);
assert.ok(Math.abs(pyr.levels[6].gt[1] - 0.64) < 1e-12);
assert.equal(pyr.bytesPerCell, 2);
assert.equal(flatLevels(pyr.levels).length, 70);

// a trailing slash and a zarr.json URL are the same store
const again = await openZarr(path.join(root, "mur-pyramid.zarr") + "/zarr.json", getJson);
assert.deepEqual(again.levels, pyr.levels);

const flat = await openZarr(path.join(root, "mur-full-resolution.zarr", "analysed_sst"), getJson);
assert.equal(flat.levels.length, 1);
assert.deepEqual(flat.levels[0].size, [36000, 18000]);
await assert.rejects(openZarr(path.join(root, "mur-full-resolution.zarr"), getJson), /without multiscales/);

// levels placed by a scale relative to the first item, attributes on the group
const store = {
  "s/zarr.json": { zarr_format: 3, node_type: "group", attributes: {
    "proj:code": "EPSG:3031", "spatial:dimensions": ["y", "x"],
    multiscales: { layout: [
      { asset: "a", "spatial:transform": [100, 0, -1000, 0, -100, 2000] },
      { asset: "b", transform: { scale: [4, 2] } } ] } } },
  "s/a/zarr.json": { zarr_format: 3, node_type: "array", shape: [3, 40, 20], data_type: "float32",
    dimension_names: ["time", "y", "x"], chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 16, 8] } } },
  "s/b/zarr.json": { zarr_format: 3, node_type: "array", shape: [3, 10, 10], data_type: "float32",
    dimension_names: ["time", "y", "x"], chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 16, 8] } } },
};
const s = await openZarr("s", async (u) => { if (!store[u]) throw new Error("404 " + u); return store[u]; });
assert.equal(s.crs, "EPSG:3031");
assert.deepEqual(s.levels[0], { gt: [-1000, 100, 0, 2000, 0, -100], size: [20, 40], chunk: [8, 16] });
assert.deepEqual(s.levels[1], { gt: [-1000, 200, 0, 2000, 0, -400], size: [10, 10], chunk: [8, 16] });

// node registration shifts half a cell; a non-affine transform is refused
assert.deepEqual(geotransform({ "spatial:transform": [1, 0, 10, 0, -1, 50], "spatial:registration": "node" }),
                 [9.5, 1, 0, 50.5, 0, -1]);
assert.equal(geotransform({ "spatial:transform": [1, 0, 10, 0, -1, 50], "spatial:transform_type": "rpc" }), null);
assert.throws(() => levelOf({ node_type: "array", shape: [4, 4], chunk_grid: { name: "regular", configuration: { chunk_shape: [2, 2] } } }),
              /spatial:transform/);

// a real store when wxylib/fixtures is checked out beside this repository
const fx = path.join(process.env.WXY_FIXTURES || path.join(root, "..", "..", "..", "..", "fixtures"), "zarr", "world-int16-spatial.zarr");
try {
  await readFile(path.join(fx, "zarr.json"));
  const w = await openZarr(path.join(fx, "data"), getJson);
  assert.deepEqual(w.levels[0].size, [720, 360]);
  assert.deepEqual(w.levels[0].chunk, [100, 100]);
  console.log("fixtures store:", w.crs, JSON.stringify(w.levels[0].gt));
} catch (e) {
  if (e.code !== "ENOENT") throw e;
  console.log("skipping the fixtures store: no checkout");
}
console.log("zarrmeta: ok");
