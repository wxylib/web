"""Write the metadata-only Zarr stores the view plan page reads.

A plan needs no chunk: the page reads zarr.json files and nothing else.
Two stores with the shape of GHRSST MUR (36000 x 18000 cells of 0.01
degree, 512 x 512 chunks of int16):

- www/data/zarr/mur-pyramid.zarr: a group with `multiscales` (the
  zarr-conventions multiscales layout) over arrays 0 to 6, each half the
  size of the one before, with `spatial:` and `proj:` attributes;
- www/data/zarr/mur-full-resolution.zarr: the same grid as one array, as
  a virtual store over netCDF files has it.

Run from the repository root: python3 scripts/zarr_pyramid_metadata.py
"""
import json
import math
import os

NX, NY, RES, CHUNK, LEVELS = 36000, 18000, 0.01, 512, 7
ROOT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "zarr")


def array_meta(nx, ny, res):
    return {
        "zarr_format": 3,
        "node_type": "array",
        "shape": [ny, nx],
        "data_type": "int16",
        "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [CHUNK, CHUNK]}},
        "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
        "fill_value": -32768,
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}},
                   {"name": "zstd", "configuration": {"level": 3, "checksum": False}}],
        "dimension_names": ["y", "x"],
        "attributes": {
            "spatial:dimensions": ["y", "x"],
            "spatial:transform": [res, 0.0, -180.0, 0.0, -res, 90.0],
            "spatial:shape": [ny, nx],
            "proj:code": "EPSG:4326",
        },
    }


def write(path, meta):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(meta, f, indent=1)
        f.write("\n")


def main():
    pyramid = os.path.join(ROOT, "mur-pyramid.zarr")
    layout = []
    for k in range(LEVELS):
        f = 2 ** k
        nx, ny = math.ceil(NX / f), math.ceil(NY / f)
        write(os.path.join(pyramid, str(k), "zarr.json"), array_meta(nx, ny, RES * f))
        item = {"asset": str(k), "transform": {"scale": [float(f), float(f)], "translation": [0.0, 0.0]}}
        if k:
            item["derived_from"] = str(k - 1)
            item["resampling_method"] = "average"
        layout.append(item)
    write(os.path.join(pyramid, "zarr.json"), {
        "zarr_format": 3,
        "node_type": "group",
        "attributes": {
            "multiscales": {"layout": layout, "resampling_method": "average"},
            "spatial:dimensions": ["y", "x"],
            "proj:code": "EPSG:4326",
        },
    })
    flat = os.path.join(ROOT, "mur-full-resolution.zarr")
    write(os.path.join(flat, "zarr.json"), {"zarr_format": 3, "node_type": "group", "attributes": {}})
    write(os.path.join(flat, "analysed_sst", "zarr.json"), array_meta(NX, NY, RES))


if __name__ == "__main__":
    main()
