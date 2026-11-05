"""Check the VRT discovery page's teaching examples (www/data/vrt-examples)
open and read as described, with the GDAL in the rasterio and pyogrio
wheels. Run from anywhere:

    pip install rasterio pyogrio numpy
    python scripts/vrt_examples_check.py

names.vrt band 2 reads a remote COG and is skipped (no network needed).
mdim-stack.vrt needs the multidimensional API, which these wheels do not
expose, so it is only parsed here.
"""

import os
import xml.etree.ElementTree as ET

import numpy as np
import pyogrio
import rasterio

HERE = os.path.dirname(os.path.abspath(__file__))
EX = os.path.join(HERE, "..", "www", "data", "vrt-examples")
CORPUS = os.path.join(HERE, "..", "www", "data", "vrt-corpus", "src")


def src(name):
    with rasterio.open(os.path.join(CORPUS, name)) as d:
        return d.read().astype("float32")


def check(label, ok):
    print(("ok   " if ok else "FAIL ") + label)
    return ok


def main():
    good = True
    print("GDAL", rasterio.__gdal_version__)
    rgb = src("rgb.tif")
    with rasterio.open(os.path.join(EX, "derived.vrt")) as d:
        b1, b3 = d.read(1), d.read(3)
    with np.errstate(all="ignore"):
        nd = (rgb[1] - rgb[0]) / (rgb[1] + rgb[0])
    good &= check("derived.vrt band 1 is norm_diff(green, red)", np.allclose(b1, nd, equal_nan=True))
    good &= check("derived.vrt band 3 is red + blue + 100", np.allclose(b3, rgb[0] + rgb[2] + 100))
    print("     derived.vrt band 2 (expression) needs a build with muparser or ExprTk; not checked")

    tile0 = src("tile0.tif")[0]
    with rasterio.open(os.path.join(EX, "warped.vrt")) as d:
        w = d.read(1)
        good &= check("warped.vrt opens in EPSG:3857", d.crs.to_epsg() == 3857 and w.shape == tile0.shape)

    # names.vrt band 1: the zip and vrt:// names are relative to the working
    # directory (relativeToVRT does not reach inside them), so read from EX.
    cwd = os.getcwd()
    os.chdir(EX)
    try:
        with rasterio.open("names.vrt") as d:
            a = d.read(1)
        t = [src("tile%d.tif" % i)[0] for i in range(4)]
        good &= check("names.vrt band 1: path, zip member, nested VRT, vrt:// string",
                      all(np.array_equal(x, y) for x, y in [
                          (a[:15, :20], t[0]), (a[:15, 20:], t[1]), (a[15:, :20], t[2]), (a[15:, 20:], t[3])]))
    finally:
        os.chdir(cwd)

    root = ET.parse(os.path.join(EX, "mdim-stack.vrt")).getroot()
    good &= check("mdim-stack.vrt parses (3 sources)", len(root.findall(".//Source")) == 3)

    p = os.path.join(EX, "vector.vrt")
    want = {"stations": 5, "ports": 2, "places": 7, "stations_polar": 5}
    for layer, n in want.items():
        meta, table = pyogrio.read_arrow(p, layer=layer)
        good &= check("vector.vrt %s: %d features" % (layer, n), table.num_rows == n)
    meta, _ = pyogrio.read_arrow(p, layer="stations_polar")
    good &= check("vector.vrt stations_polar in EPSG:3031", meta["crs"] == "EPSG:3031")
    raise SystemExit(0 if good else 1)


if __name__ == "__main__":
    main()
