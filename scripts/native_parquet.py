"""Write www/data/vrt/countries-native.parquet from countries.parquet.

The copy has a native Parquet GEOMETRY column (Parquet 2.11 geospatial
types, the base of GeoParquet 2.0) and no "geo" metadata, with the same
rows and columns. Needs pyarrow >= 21 and geoarrow-pyarrow:

    python scripts/native_parquet.py
"""
import json
from pathlib import Path

import geoarrow.pyarrow as ga
import pyarrow as pa
import pyarrow.parquet as pq

here = Path(__file__).resolve().parent.parent / "www" / "data" / "vrt"
t = pq.read_table(here / "countries.parquet")
geo = json.loads(t.schema.metadata[b"geo"])
col = geo["primary_column"]
wkb = ga.as_wkb(t.column(col).combine_chunks().cast(pa.binary()))
t = t.set_column(t.schema.get_field_index(col), col, wkb).replace_schema_metadata(None)
pq.write_table(t, here / "countries-native.parquet", compression="zstd", store_schema=False)
