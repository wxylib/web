"""GDAL's reading of the example vector VRTs, for scripts/vrt-test.mjs.

    python scripts/vrt_oracle.py > scripts/vrt-oracle.json

Reads every layer of www/data/vrt/*.vrt with GDAL (through pyogrio, whose
wheels carry GDAL and its OGR_VRT driver) and writes each feature's
attributes and geometry. GDAL in these wheels has no Parquet driver, so the
GeoParquet example is read through a GeoJSON copy of its source, written
here with pyarrow. Remote sources need network access.
"""
import glob
import json
import os
import sys
import tempfile

import pyarrow.parquet as pq
import pyogrio
import shapely
from pyogrio.raw import read_arrow

HERE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "www", "data", "vrt")
# A view to read the FlatGeobuf example through (lon/lat), as the page does.
BBOX = {"uscounties.vrt": (-77.5, 38.5, -76.5, 39.5)}


def plain(v):
    if hasattr(v, "item"):
        v = v.item()
    if isinstance(v, float) and v != v:
        return None
    return v


def layer_json(path, layer, bbox=None):
    # The Arrow path: pyogrio's other reader sizes its arrays by the feature
    # count, which a union layer reports as 0.
    meta, table = read_arrow(path, layer=layer, bbox=bbox, return_fids=True)
    rows = table.to_pylist()
    gcol = meta["geometry_name"] or "wkb_geometry"
    out = []
    for r in rows:
        wkb = r.get(gcol)
        g = shapely.from_wkb(wkb) if wkb is not None else None
        out.append({
            "fid": r.get("OGC_FID"),
            "properties": {k: plain(r.get(k)) for k in meta["fields"]},
            "geometry": json.loads(shapely.to_geojson(g)) if g is not None else None,
        })
    return {"fields": list(meta["fields"]), "crs": meta["crs"], "features": out}


def parquet_as_geojson(src, dst):
    t = pq.read_table(src).to_pylist()
    feats = [{"type": "Feature", "properties": {k: v for k, v in r.items() if k != "geometry"},
              "geometry": json.loads(shapely.to_geojson(shapely.from_wkb(r["geometry"])))} for r in t]
    with open(dst, "w") as f:
        json.dump({"type": "FeatureCollection", "features": feats}, f)


def main():
    result = {}
    tmp = tempfile.mkdtemp()
    for vrt in sorted(glob.glob(os.path.join(HERE, "*.vrt"))):
        name = os.path.basename(vrt)
        path = vrt
        text = open(vrt).read()
        if ".parquet" in text:
            for src in glob.glob(os.path.join(HERE, "*.parquet")):
                parquet_as_geojson(src, os.path.join(tmp, os.path.basename(src)[:-8] + ".geojson"))
            path = os.path.join(tmp, name)
            with open(path, "w") as f:
                f.write(text.replace('relativeToVRT="1">', 'relativeToVRT="0">' + tmp + "/")
                        .replace(".parquet<", ".geojson<"))
        layers = {}
        for lname, _ in pyogrio.list_layers(path):
            layers[lname] = layer_json(path, lname, BBOX.get(name))
        result[name] = {"bbox": BBOX.get(name), "layers": layers}
        print(name, {k: len(v["features"]) for k, v in layers.items()}, file=sys.stderr)
    json.dump(result, sys.stdout, indent=None, separators=(",", ":"))


if __name__ == "__main__":
    main()
