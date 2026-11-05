# VRT examples for the discovery page

Written for `vrt.html`; sources are the corpus files in `../vrt-corpus/src`.
`python scripts/vrt_examples_check.py` checks them with GDAL 3.12 (the
rasterio and pyogrio wheels).

- `derived.vrt`: three derived bands over `rgb.tif`: `norm_diff`,
  `expression` (needs a build with muparser or ExprTk, not checked) and
  `sum` with `k`.
- `warped.vrt`: `tile0.tif` warped to EPSG:3857, as GDAL writes it.
- `names.vrt`: one band from four names (a relative path, a zip member, a
  nested VRT, a `vrt://` string) and one from a remote COG over
  `/vsicurl/`. The zip and `vrt://` names resolve against the working
  directory, not the VRT: in GDAL 3.12.2 `relativeToVRT="1"` does not reach
  inside `/vsizip/{...}` or a `vrt://` string.
- `mdim-stack.vrt`: the three bands of `rgb.tif` as three time steps.
  Parsed, not checked against GDAL (the wheels have no multidimensional
  API).
- `vector.vrt` with `stations.csv` and `coast.geojson`: points from x/y
  columns, a layer from SQL, a union layer and a reprojected layer.
