"""Write the BRAN2023 refs extract that www/bran.html reads by default.

A few depth levels of the store's flat mdim-refs table (every day, every
chunk), as compact JSON: the page needs only path, offset and size per
chunk, and the array's packing. When the store is public the page can read
the table itself; until then this is the table, cut down.

    AWS_S3_ENDPOINT=... AWS_VIRTUAL_HOSTING=NO python3 scripts/bran_extract.py \
        [store] [out.json]

The store defaults to BRAN_STORE, then the 2010 test store; it needs read
access (AWS_* in the environment) while the store is keyed.
"""
import json, os, sys
import pyarrow.fs as pafs
import pyarrow.parquet as pq

store = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
    "BRAN_STORE", "s3://aadc-transfer/michae_sum/e2e/bran2023-daily-temp"))
out = sys.argv[2] if len(sys.argv) > 2 else "www/data/bran2023-temp-2010.json"
LEVELS = [0, 14, 26, 33]   # 2.5, 105, 233 and 545 m

if store.startswith("s3://"):
    fs = pafs.S3FileSystem(
        endpoint_override=os.environ.get("AWS_S3_ENDPOINT"),
        force_virtual_addressing=os.environ.get("AWS_VIRTUAL_HOSTING", "YES") != "NO")
    root = store[5:]
else:
    fs, root = pafs.LocalFileSystem(), store
with fs.open_input_stream(f"{root}/flat/arrays.json") as f:
    arrays = {a["array"]: a for a in json.loads(f.read())["arrays"]}
temp = arrays["temp"]
refs = pq.read_table(f"{root}/flat/refs_temp.parquet", filesystem=fs).to_pandas()
refs = refs[refs.dim_1.isin(LEVELS)].sort_values(["dim_1", "dim_0", "dim_2", "dim_3"])
files = sorted(refs.path.unique())
nt, nz, ny, nx = temp["shape"]
cy, cx = ny // temp["chunks"][2], nx // temp["chunks"][3]
depth = arrays["st_ocean"]["values"]


def coord(name):
    a = arrays[name]["affine"]
    return {"start": a["start"], "step": a["step"]}


doc = {
    "about": "BRAN2023 daily temp, 2010: a cut of the mdim-refs table at a few depths",
    "store": store,
    "array": "temp",
    "shape": temp["shape"], "chunks": temp["chunks"], "chunk_grid": [nt, cy, cx],
    "dtype": temp["dtype"], "codec": temp["codec"], "fill": int(temp["fill"]),
    "scale_factor": temp["attrs"]["scale_factor"], "add_offset": temp["attrs"]["add_offset"],
    "units": temp["attrs"]["units"],
    "time": {"units": arrays["Time"]["attrs"].get("units", "days since 1979-01-01"),
             **coord("Time")},
    "x": coord("xt_ocean"), "y": coord("yt_ocean"),
    "files": [p.removeprefix("/vsicurl/") for p in files],
    "levels": [],
}
fidx = {p: i for i, p in enumerate(files)}
for z in LEVELS:
    r = refs[refs.dim_1 == z]
    assert len(r) == nt * cy * cx and r.present.all()
    doc["levels"].append({
        "z": z, "depth": round(depth[z], 2),
        # per day: which file; per chunk, in (day, y, x) order: offset, size
        "file": [fidx[p] for p in r.path.values[::cy * cx]],
        "offset": r.offset.astype(int).tolist(),
        "size": r["size"].astype(int).tolist(),
    })
with open(out, "w") as f:
    json.dump(doc, f, separators=(",", ":"))
print(out, os.path.getsize(out), "bytes")
