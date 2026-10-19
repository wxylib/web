# wxylib/web

wxylib in the browser. A Cloud Optimized GeoTIFF is opened over HTTP range
requests by `wxy-tiff` and warped by `wxy-warp`, both compiled to
WebAssembly, onto the canvas. The canvas is the target grid: drag to pan,
scroll to zoom, and every view is a fresh warp with the same code the
`wxy warp` command runs (GDAL's chunked warp, kernels and overview choice).
Rendering is warping to a screen grid.

![A Sentinel-2 scene over Hobart, in UTM zone 55S, warped in the browser to
south polar stereographic (EPSG:3031)](docs/img/hobart-3031.png)

A Sentinel-2 true colour scene over Hobart (UTM 55S) on south polar
stereographic: 144 ms for the warp, five range requests (header, image
directories and the coarsest overview's tiles, 0.74 MB). Zoomed in, the
warp switches to full resolution as gdalwarp's `-ovr AUTO` would, and
fetches only the tiles the view touches:

![The same scene zoomed in to full resolution](docs/img/hobart-3031-zoom.png)

## Sentinel-2 on a web map

The landing page (`www/index.html`, the Pages root) lists the examples.

`www/s2.html` browses Sentinel-2 L2A: a STAC search of the map view
(Earth Search, `sentinel-2-l2a`, dates and a cloud limit), footprints and a
scene list, and the chosen scene drawn from its raw uint16 band COGs. Each
of three bands is warped by `wxy-warp` onto the map's own Web Mercator
pixel grid (the part of the view the scene covers) whenever the map stops
moving; the page then turns them into colour: reflectance from the STAC
`raster:bands` scale (the offset is skipped when
`earthsearch:boa_offset_applied` says it is already removed), a black and
white point, and gamma. The sliders repaint without warping again. Band
sets: true colour, false colour, SWIR and agriculture; the 20 m bands are
warped onto the same grid as the 10 m ones.

![Hobart at 10 m: B4, B3 and B2 warped from UTM 55S to the map grid at full
resolution](docs/img/s2-hobart.jpg)

Hobart at full resolution, 3 bands warped from UTM 55S to the map grid.
Zoomed out, the whole scene comes from the coarsest overviews (5 range
requests per band, 1.8 MB for all three):

![The whole scene, true colour, with STAC footprints](docs/img/s2-scene.jpg)

With "Group by solar day" ticked, the list shows days instead of scenes
(UTC time shifted by the scene's longitude, so a pass at 23:58 UTC over
Tasmania counts as the next local morning). Clicking a day loads all its
scenes in view onto the map. Every load, one scene or a day, cuts the view
into 256 pixel blocks and warps them nearest the centre first (nearest
scene first within a block), three at a time, painting each as it lands.
Loading controls: at most N scenes (those nearest the centre), a cap on
the data read (the load stops there and says so), a Stop button, and
"Hold the map still while loading", which disables panning and zooming
until the load ends. Without the hold, moving the map abandons the load
and starts again from the new centre; the old picture stays until the new
one is done.

![A solar day of two scenes, 55GDN and 55GEN, side by side](docs/img/s2-day.jpg)

Blocks fill from the centre out; this load stopped at a 20 MB cap:

![A full-resolution load stopped at the cap](docs/img/s2-capped.jpg)

In these screenshots the basemap tiles and the STAC response were stubbed
(the build machine cannot reach them; the STAC items are the real ones from
the `sentinel-cogs` bucket). The band reads and warps are live.

Not yet: overlapping scenes are drawn over each other, not mosaicked by
a rule (latest, least cloud); the warp runs on the page's thread; and each
full-resolution view fetches whole 1024 by 1024 tiles (about 1.5 MB each
per band), so zooming in on a slow link is slow.

## GeoParquet, queried in the browser

`www/vector.html` runs SQL over remote GeoParquet with DuckDB (wasm) and
shows the result twice: as a table, and its `geometry` column (WKB) drawn
on the map. Click a row to find its feature, or a feature to find its row.
None of it is wxylib code. Vector access and query already exist (DuckDB,
DataFusion, geoarrow-rs; design m09, section 6), so this page shows the
piece wxylib hands vector work to rather than a new crate.

The default sources are Overture Maps buildings (512 files, about 230 GB)
and places (16 files, about 11 GB), latest release. Three levels of
pruning keep a view's query small:

1. the Overture STAC catalog gives each file's bbox, so only the files the
   view meets are opened (all 512 buildings footers would be 471 MB; the
   one file under central Hobart has a 1.5 MB footer);
2. DuckDB reads that footer and keeps only the row groups whose `bbox`
   column statistics meet the view;
3. within those, it fetches only the columns the query names.

A view of central Hobart's buildings then reads about 10 MB (measured
with pyarrow, footer included). The status line counts the requests and bytes DuckDB
makes. `{files}` and `{xmin}` to `{ymax}` in the SQL are filled in from
the source and the map view; a query without `{files}` runs as written,
and `?url=...` or `?sql=...` open one directly.

![Overture building footprints in central Hobart and their attribute
table](www/img/vector.jpg)

Not yet: DuckDB loads its Parquet reader as an extension from
extensions.duckdb.org on first use, which the build machine cannot reach,
so this page was tested here with the rendering, WKB decoding (identical
to shapely on Overture polygons), file pruning (against a stubbed STAC
catalog) and byte counting, and the reads above were measured with
pyarrow; the screenshot's rows are the real Overture rows for that view.
No basemap tiles in the screenshot for the same reason. Big polygons are
costly: Overture division areas put whole countries in a row group, and a
city view of them reads about 170 MB of geometry.

## What is in it

- `src/fetch.rs`: an async-tiff reader over the browser's `fetch` with
  `Range` headers, caching each range, so panning re-reads tiles from
  memory.
- `src/render.rs`: the view (CRS, extent, size, resampling), the overview
  choice and the warp, as `f32` planes with `NaN` for nothing. No
  JavaScript here, so it is tested natively against wxylib/fixtures.
- `src/lib.rs`: the wasm surface, one class:

  ```js
  import init, { Cog } from "./pkg/wxy_web.js";
  await init();
  const cog = await Cog.open(url);          // server must allow CORS
  JSON.parse(cog.info());                   // size, bands, dtype, crs, overviews
  cog.bounds("EPSG:3031");                  // source extent in a CRS
  const out = await cog.warp("EPSG:3031", [xmin, xmax, ymin, ymax], 720, 540, "bilinear");
  // out.values: Float32Array, band by band; out.bands, out.level,
  // out.requests, out.bytes
  ```

- `www/index.html`: the landing page, listing the examples.
- `www/s2.html`, `www/s2.js`: Sentinel-2 on a web map.
- `www/vector.html`, `www/vector.js`, `www/wkb.js`: GeoParquet queried in the browser.
- `www/cog.html`, `www/cog.js`: one COG, any projection. Colouring is in JavaScript (percentile stretch; a
  sea and land ramp when values straddle zero, viridis otherwise, RGB for
  three bands). While dragging it warps at half size with nearest
  neighbour, then once more at full size when the view settles.

Sources in the menu: two synthetic wxylib/fixtures COGs (served by
raw.githubusercontent.com, which allows CORS and ranges) and a Sentinel-2
scene from the `sentinel-cogs` bucket. Any CORS-enabled COG URL works, and
`?url=...&crs=...` opens one directly.

CRS is proj4rs, pure Rust: EPSG codes and proj strings for the projections
it implements (stere, laea, merc, moll, geos, lcc, tmerc and more), no
datum grids. Two gaps found while building this: `+proj=laea` at a pole
(`+lat_0=-90`) maps nothing, and `+proj=aeqd` is not registered. proj-wasm
is the planned route to full PROJ (design gate 4).

## Build and run

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129   # the version in Cargo.lock
scripts/build.sh                                   # -> www/pkg/
python3 -m http.server -d www 8000                 # open http://localhost:8000/
```

clang is needed for zstd's C code. `cargo test` runs the native tests; they
look for wxylib/fixtures at `../fixtures` or `$WXY_FIXTURES` and skip
without it.

wxylib/core is pinned by git rev in `Cargo.toml`; bump it there.

## Not yet

- The warp runs on the page's thread. Moving it to a worker keeps the
  page responsive on big views.
- Zarr: `wxy-zarr` does not build for wasm until `ChunkSource` drops its
  `Send`/`Sync` bound there (design doc 03, section 5). Virtual stores
  (Icechunk) are further off.
- One source band set, one view; no tile pyramid, and the vector page is
  separate from the raster ones (no vectors over a warped COG yet).

Documentation: **https://wxylib.org/docs/**, one place for what works, how-tos,
explainers, the design documents and how to help.

License: MIT OR Apache-2.0.
