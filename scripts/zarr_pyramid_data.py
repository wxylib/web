"""Write the small Zarr pyramid with data that the view plan page draws.

One day of GHRSST MUR sea surface temperature (2024-01-15, stored int16
counts) at 0.125 degree, with three levels of 2 x 2 averages above it:
www/data/zarr/ghrsst-mur-20240115.zarr, a group with `multiscales` over
arrays 0 to 3, each with `spatial:` and `proj:` attributes, in chunks of
180 x 180 cells (zstd).

Level 0 is a `wxy warp` of the source COG:

  wxy warp https://data.source.coop/ausantarctic/ghrsst-mur-v2/2024/01/15/\
20240115090000-JPL-L4_GHRSST-SSTfnd-MUR-GLOB-v02.0-fv04.1_analysed_sst.tif \
    level0.zarr --array /0 --crs EPSG:4326 --extent -180 -90 180 90 \
    --size 2880 1440 -r average

Then, from the repository root (needs zarr 3 and numpy):

  python3 scripts/zarr_pyramid_data.py level0.zarr
"""
import json
import os
import shutil
import sys

import numpy as np
import zarr
from zarr.codecs import BytesCodec, ZstdCodec

CHUNK, LEVELS, RES, NODATA = 180, 4, 0.125, -32768
OUT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "zarr", "ghrsst-mur-20240115.zarr")


def halve(a):
    """2 x 2 means over the cells that hold data, rounded to int16."""
    ny, nx = a.shape
    b = a.reshape(ny // 2, 2, nx // 2, 2).astype(np.float64)
    ok = b != NODATA
    n = ok.sum(axis=(1, 3))
    s = np.where(ok, b, 0.0).sum(axis=(1, 3))
    return np.where(n > 0, np.rint(s / np.maximum(n, 1)), NODATA).astype(np.int16)


def main(level0):
    a = np.asarray(zarr.open_array(os.path.join(level0, "0"), mode="r")[:]).squeeze()
    assert a.shape == (1440, 2880) and a.dtype == np.int16, (a.shape, a.dtype)
    shutil.rmtree(OUT, ignore_errors=True)
    layout = []
    for k in range(LEVELS):
        f = 2 ** k
        ny, nx = a.shape
        z = zarr.create_array(
            os.path.join(OUT, str(k)), shape=a.shape, chunks=(CHUNK, CHUNK), dtype="int16",
            fill_value=NODATA, dimension_names=["y", "x"], zarr_format=3,
            serializer=BytesCodec(endian="little"), compressors=[ZstdCodec(level=9)], filters=None,
            attributes={
                "spatial:dimensions": ["y", "x"],
                "spatial:transform": [RES * f, 0.0, -180.0, 0.0, -RES * f, 90.0],
                "spatial:shape": [ny, nx],
                "proj:code": "EPSG:4326",
                "_FillValue": NODATA,
            })
        z[:] = a
        item = {"asset": str(k), "transform": {"scale": [float(f), float(f)], "translation": [0.0, 0.0]}}
        if k:
            item["derived_from"] = str(k - 1)
            item["resampling_method"] = "average"
        layout.append(item)
        a = halve(a)
    with open(os.path.join(OUT, "zarr.json"), "w") as fh:
        json.dump({
            "zarr_format": 3,
            "node_type": "group",
            "attributes": {
                "multiscales": {"layout": layout, "resampling_method": "average"},
                "spatial:dimensions": ["y", "x"],
                "proj:code": "EPSG:4326",
            },
        }, fh, indent=1)
        fh.write("\n")


if __name__ == "__main__":
    main(sys.argv[1])
