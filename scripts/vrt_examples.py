"""Write the small sources behind the example vector VRTs in www/data/vrt.

    python scripts/vrt_examples.py

Needs pyproj, pyarrow and shapely. The station positions are approximate
(to about 1 km); the routes are straight lines in polar stereographic,
drawn to show a WKT column, not ship tracks. countries.parquet is Natural
Earth 1:110m admin 0 countries (public domain), cut to five columns.
"""
import csv
import json
import os
import urllib.request

import pyarrow as pa
import pyarrow.parquet as pq
import shapely
from pyproj import Transformer

OUT = os.path.join(os.path.dirname(__file__), "..", "www", "data", "vrt")
NE = ("https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
      "v5.1.2/geojson/ne_110m_admin_0_countries.geojson")

COLOUR = {
    "Australia": "#d9480f", "France": "#1971c2", "France and Italy": "#1971c2",
    "United States": "#5f3dc4", "New Zealand": "#2b8a3e", "Russia": "#c2255c",
    "China": "#e03131", "United Kingdom": "#0c8599", "Japan": "#f08c00",
    "India": "#862e9c",
}
# name, operator, longitude, latitude, year opened
STATIONS = [
    ("Casey", "Australia", 110.527, -66.282, 1969),
    ("Davis", "Australia", 77.967, -68.577, 1957),
    ("Mawson", "Australia", 62.874, -67.603, 1954),
    ("Macquarie Island", "Australia", 158.937, -54.500, 1948),
    ("Dumont d'Urville", "France", 140.001, -66.663, 1956),
    ("Concordia", "France and Italy", 123.333, -75.100, 2005),
    ("McMurdo", "United States", 166.668, -77.846, 1956),
    ("Palmer", "United States", -64.054, -64.774, 1968),
    ("Scott Base", "New Zealand", 166.768, -77.849, 1957),
    ("Mirny", "Russia", 93.010, -66.553, 1956),
    ("Vostok", "Russia", 106.837, -78.465, 1957),
    ("Zhongshan", "China", 76.372, -69.373, 1989),
    ("Great Wall", "China", -58.967, -62.217, 1985),
    ("Rothera", "United Kingdom", -68.125, -67.568, 1975),
    ("Syowa", "Japan", 39.582, -69.004, 1957),
    ("Bharati", "India", 76.193, -69.407, 2012),
    ("Maitri", "India", 11.733, -70.767, 1989),
]
HOBART = (147.327, -42.883)


def write_csv(name, header, rows):
    with open(os.path.join(OUT, name), "w", newline="", encoding="ascii") as f:
        w = csv.writer(f, lineterminator="\n")
        w.writerow(header)
        w.writerows(rows)


def main():
    os.makedirs(OUT, exist_ok=True)
    to3031 = Transformer.from_crs("EPSG:4326", "EPSG:3031", always_xy=True)

    # Points as two columns, in longitude and latitude, with an OGR style
    # string per row.
    write_csv("stations.csv", ["name", "operator", "lon", "lat", "opened", "style"],
              [(n, o, x, y, yr, f"SYMBOL(c:{COLOUR[o]})") for n, o, x, y, yr in STATIONS])

    # The same stations as polar stereographic metres, for the warped layer.
    rows = []
    for n, o, x, y, yr in STATIONS:
        px, py = to3031.transform(x, y)
        rows.append((n, o, f"{px:.1f}", f"{py:.1f}", yr))
    write_csv("stations-3031.csv", ["name", "operator", "x", "y", "opened"], rows)

    # Lines as WKT in polar stereographic: Hobart to each Australian station.
    hx, hy = to3031.transform(*HOBART)
    rows = []
    for n, o, x, y, _ in STATIONS:
        if o != "Australia":
            continue
        sx, sy = to3031.transform(x, y)
        line = shapely.LineString([(hx, hy), (sx, sy)]).segmentize(50000)
        rows.append((f"Hobart to {n}", round(line.length / 1000), shapely.to_wkt(line, rounding_precision=0)))
    write_csv("routes.csv", ["route", "proj_km", "geom_wkt"], rows)

    # GeoParquet: WKB geometry, geo metadata, no crs (so OGC:CRS84).
    with urllib.request.urlopen(NE) as r:
        ne = json.load(r)
    cols = {"NAME": [], "CONTINENT": [], "ISO_A3": [], "POP_EST": [], "geometry": []}
    bboxes = []
    for f in ne["features"]:
        p = f["properties"]
        g = shapely.geometry.shape(f["geometry"])
        for k in ("NAME", "CONTINENT", "ISO_A3"):
            cols[k].append(p[k])
        cols["POP_EST"].append(int(p["POP_EST"]))
        cols["geometry"].append(shapely.to_wkb(g))
        bboxes.append(g.bounds)
    xs = [b[0] for b in bboxes] + [b[2] for b in bboxes]
    ys = [b[1] for b in bboxes] + [b[3] for b in bboxes]
    geo = {"version": "1.1.0", "primary_column": "geometry", "columns": {"geometry": {
        "encoding": "WKB", "geometry_types": ["Polygon", "MultiPolygon"],
        "bbox": [min(xs), min(ys), max(xs), max(ys)]}}}
    table = pa.table({
        "NAME": pa.array(cols["NAME"], pa.string()),
        "CONTINENT": pa.array(cols["CONTINENT"], pa.string()),
        "ISO_A3": pa.array(cols["ISO_A3"], pa.string()),
        "POP_EST": pa.array(cols["POP_EST"], pa.int64()),
        "geometry": pa.array(cols["geometry"], pa.binary()),
    }).replace_schema_metadata({"geo": json.dumps(geo)})
    pq.write_table(table, os.path.join(OUT, "countries.parquet"), compression="snappy")


if __name__ == "__main__":
    main()
