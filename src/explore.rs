//! The VRT discovery page's use of `vrt-model`: classic documents, source
//! names, `vrt://` lowering and read plans, each as JSON for the page.
//!
//! Nothing here reads bytes. The page fetches documents and source headers
//! and hands them in; this module says what they hold and what a read of
//! them would touch. Natively testable against the wxylib/fixtures corpus.

use std::collections::HashMap;

use serde_json::{json, Value};
use vrt_model::plan::{nearest_indices, parent_of};
use vrt_model::vrtcon::{lower, SourceInfo, LOWERED};
use vrt_model::{plan_band, plan_band_leaves, Dataset, Dsn, Op, Request, Resolver, SourceWindow};

/// A source name as a tree: its kind, its parts, and the name it reads
/// back to.
pub fn dsn_value(d: &Dsn) -> Value {
    let mut v = match d {
        Dsn::Path(p) => json!({"kind": "path", "path": p}),
        Dsn::Url(u) => json!({"kind": "url", "url": u}),
        Dsn::Vsi {
            handler,
            inner,
            path,
        } => json!({
            "kind": "vsi",
            "handler": handler,
            "inner": inner.as_ref().map(|i| dsn_value(i)),
            "path": path,
            "archive": d.is_archive(),
        }),
        Dsn::Driver {
            prefix,
            source,
            quoted,
            subdataset,
        } => json!({
            "kind": "driver",
            "prefix": prefix,
            "source": dsn_value(source),
            "quoted": quoted,
            "subdataset": subdataset,
        }),
        Dsn::VrtString { source, options } => json!({
            "kind": "vrtstring",
            "source": dsn_value(source),
            "options": options.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>(),
            "lowered": LOWERED,
        }),
        Dsn::Inline(_) => json!({"kind": "inline"}),
    };
    v["text"] = json!(d.to_string());
    v["leaf"] = json!(d.leaf().to_string());
    v["virtual"] = json!(d.is_virtual());
    v
}

/// Parse a source name.
pub fn dsn_json(s: &str) -> String {
    dsn_value(&Dsn::parse(s)).to_string()
}

fn rect(r: &Option<vrt_model::Rect>) -> Value {
    match r {
        Some(r) => json!([r.x_off, r.y_off, r.x_size, r.y_size]),
        None => Value::Null,
    }
}

fn attrs(a: &[(String, String)]) -> Value {
    Value::Object(a.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

fn op_value(o: &Op) -> Value {
    match o {
        Op::SkipNodata(n) => json!({"op": "skip_nodata", "value": num(*n)}),
        Op::Linear { ratio, offset } => json!({"op": "linear", "ratio": ratio, "offset": offset}),
        Op::Lut(t) => {
            json!({"op": "lut", "pairs": t.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()})
        }
    }
}

/// NaN and infinities are not JSON numbers: write them as text.
fn num(v: f64) -> Value {
    if v.is_finite() {
        json!(v)
    } else {
        json!(v.to_string())
    }
}

/// A classic VRT as the model reads it: grid, bands, sources (each name
/// parsed), what the model kept without interpreting, and whether the
/// document reads back from what the model writes.
pub fn classic_value(ds: &Dataset) -> Value {
    let bands: Vec<Value> = ds
        .bands
        .iter()
        .map(|b| {
            let sources: Vec<Value> = b
                .sources
                .iter()
                .map(|s| {
                    json!({
                        "kind": s.kind,
                        "filename": dsn_value(&s.filename),
                        "relative": s.relative,
                        "filename_attrs": attrs(&s.filename_attrs),
                        "source_band": s.source_band,
                        "declared_size": s.declared_size().map(|(x, y)| json!([x, y])),
                        "properties": s.properties.as_ref().map(|p| attrs(&p.attrs)),
                        "src_rect": rect(&s.src_rect),
                        "dst_rect": rect(&s.dst_rect),
                        "nodata": s.nodata,
                        "scale_offset": s.scale_offset,
                        "scale_ratio": s.scale_ratio,
                        "lut": s.lut.as_ref().map(|t| t.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>()),
                        "resampling": s.resampling,
                        "extra_attrs": attrs(&s.extra_attrs),
                        "extra": s.extra.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
                    })
                })
                .collect();
            json!({
                "data_type": b.data_type,
                "band": b.band,
                "sub_class": b.sub_class,
                "nodata": b.nodata,
                "sources": sources,
                "extra_attrs": attrs(&b.extra_attrs),
                "extra": b.extra.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
            })
        })
        .collect();
    let round_trip = Dataset::from_xml(&ds.to_xml())
        .map(|d| d == *ds)
        .unwrap_or(false);
    json!({
        "x_size": ds.x_size,
        "y_size": ds.y_size,
        "sub_class": ds.sub_class,
        "srs": ds.srs.as_ref().map(|e| e.text()),
        "geotransform": ds.geotransform,
        "bands": bands,
        "extra_attrs": attrs(&ds.extra_attrs),
        "extra": ds.extra.iter().map(|e| e.name.clone()).collect::<Vec<_>>(),
        "unknown": ds.unknown(),
        "round_trip": round_trip,
    })
}

/// Read a classic VRT document: `{"ok": true, "dataset": ...}` or
/// `{"ok": false, "error": ...}`.
pub fn classic_json(xml: &str) -> String {
    match Dataset::from_xml(xml) {
        Ok(ds) => json!({"ok": true, "dataset": classic_value(&ds)}).to_string(),
        Err(e) => json!({"ok": false, "error": e.to_string()}).to_string(),
    }
}

/// Lower a `vrt://` string over a source described by `info` (JSON with
/// `x_size`, `y_size`, `band_types`, `geotransform`, `srs`, `nodata`) into
/// classic VRT XML.
pub fn lower_json(dsn: &str, info: &str) -> String {
    let run = || -> Result<String, String> {
        let Dsn::VrtString { source, options } = Dsn::parse(dsn) else {
            return Err("not a vrt:// string".into());
        };
        let v: Value = serde_json::from_str(info).map_err(|e| e.to_string())?;
        let n = |k: &str| v[k].as_u64().map(|x| x as usize).ok_or(format!("info.{k}"));
        let band_types: Vec<String> = v["band_types"]
            .as_array()
            .ok_or("info.band_types")?
            .iter()
            .map(|t| t.as_str().unwrap_or("Byte").to_string())
            .collect();
        let gt = v["geotransform"].as_array().and_then(|a| {
            let g: Vec<f64> = a.iter().filter_map(|x| x.as_f64()).collect();
            (g.len() == 6).then(|| [g[0], g[1], g[2], g[3], g[4], g[5]])
        });
        let nb = band_types.len();
        let nodata = match v["nodata"].as_array() {
            Some(a) => a
                .iter()
                .map(|x| match x {
                    Value::Null => None,
                    Value::String(s) => Some(s.clone()),
                    x => Some(x.to_string()),
                })
                .collect(),
            None => vec![None; nb],
        };
        let info = SourceInfo {
            x_size: n("x_size")?,
            y_size: n("y_size")?,
            band_types,
            geotransform: gt,
            srs: v["srs"].as_str().map(str::to_string),
            nodata,
        };
        let ds = lower(&source, &options, &info).map_err(|e| e.to_string())?;
        Ok(ds.to_xml())
    };
    match run() {
        Ok(xml) => json!({"ok": true, "xml": xml}).to_string(),
        Err(e) => json!({"ok": false, "error": e}).to_string(),
    }
}

/// What the page knows about sources: sizes it read from headers, and the
/// text of nested VRT documents it fetched, keyed by the resolved name.
struct PageResolver {
    sizes: HashMap<String, (usize, usize)>,
    vrts: HashMap<String, String>,
}

impl Resolver for PageResolver {
    fn size(&self, dsn: &Dsn) -> Option<(usize, usize)> {
        let k = dsn.to_string();
        if let Some(s) = self.sizes.get(&k) {
            return Some(*s);
        }
        self.open_vrt(dsn).map(|d| (d.x_size, d.y_size))
    }
    fn open_vrt(&self, dsn: &Dsn) -> Option<Dataset> {
        Dataset::from_xml(self.vrts.get(&dsn.to_string())?).ok()
    }
}

fn window_value(w: &SourceWindow) -> Value {
    json!({"req": w.req, "req_px": w.req_px, "out": w.out})
}

/// Plan a read of `band` over `req` (`[x_off, y_off, x_size, y_size,
/// buf_x, buf_y]`). `resolver` is JSON `{"sizes": {name: [w, h]}, "vrts":
/// {name: xml}}`. The result has the band's own rows and the rows at the
/// bottom of any nesting. For a band with a pixel function, the rows are
/// the function's inputs (each read into its own buffer), marked so.
pub fn plan_json(xml: &str, base: &str, band: usize, req: &[f64], resolver: &str) -> String {
    let run = || -> Result<Value, String> {
        let mut ds = Dataset::from_xml(xml).map_err(|e| e.to_string())?;
        if req.len() != 6 {
            return Err("request needs 6 numbers".into());
        }
        let r = Request {
            x_off: req[0],
            y_off: req[1],
            x_size: req[2],
            y_size: req[3],
            buf_x: req[4] as usize,
            buf_y: req[5] as usize,
        };
        let rv: Value = serde_json::from_str(resolver).unwrap_or(json!({}));
        let mut res = PageResolver {
            sizes: HashMap::new(),
            vrts: HashMap::new(),
        };
        if let Some(m) = rv["sizes"].as_object() {
            for (k, v) in m {
                if let (Some(x), Some(y)) = (v[0].as_u64(), v[1].as_u64()) {
                    res.sizes.insert(k.clone(), (x as usize, y as usize));
                }
            }
        }
        if let Some(m) = rv["vrts"].as_object() {
            for (k, v) in m {
                if let Some(t) = v.as_str() {
                    res.vrts.insert(k.clone(), t.to_string());
                }
            }
        }
        let b = ds
            .bands
            .get_mut(band.wrapping_sub(1))
            .ok_or(format!("no band {band}"))?;
        let derived = b.sub_class.as_deref() == Some("VRTDerivedRasterBand");
        if derived {
            // The planner mosaics a band's sources; a pixel function takes
            // each source as its own input. The windows are the same.
            b.sub_class = None;
        }
        let rows = plan_band(&ds, band, &r, base, &res).map_err(|e| e.to_string())?;
        let leaves = plan_band_leaves(&ds, band, &r, base, &res).map_err(|e| e.to_string())?;
        let rows: Vec<Value> = rows
            .iter()
            .map(|p| {
                json!({
                    "source": p.source,
                    "dsn": p.dsn.to_string(),
                    "band": p.band.0,
                    "mask": p.band.1,
                    "window": window_value(&p.window),
                    "ops": p.ops.iter().map(op_value).collect::<Vec<_>>(),
                    "resampled": p.resampled,
                    "virtual": p.dsn.is_virtual(),
                })
            })
            .collect();
        let leaves: Vec<Value> = leaves
            .iter()
            .map(|l| {
                let size = res.size(&l.dsn);
                let idx = size.map(|s| nearest_indices(&l.window, s));
                json!({
                    "dsn": l.dsn.to_string(),
                    "band": l.band.0,
                    "mask": l.band.1,
                    "window": window_value(&l.window),
                    "ops": l.ops.iter().map(|lv| lv.iter().map(op_value).collect::<Vec<_>>()).collect::<Vec<_>>(),
                    "cols": idx.as_ref().map(|i| i.0.clone()),
                    "rows": idx.as_ref().map(|i| i.1.clone()),
                })
            })
            .collect();
        Ok(json!({"derived": derived, "rows": rows, "leaves": leaves}))
    };
    match run() {
        Ok(v) => json!({"ok": true, "plan": v}).to_string(),
        Err(e) => json!({"ok": false, "error": e}).to_string(),
    }
}

/// Directory part of a name, as relative sources resolve against it.
pub fn base_of(path: &str) -> String {
    parent_of(path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn corpus() -> Option<PathBuf> {
        let d = std::env::var("WXY_FIXTURES")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../fixtures"))
            .join("vrt");
        d.exists().then_some(d)
    }

    #[test]
    fn dsn_tree() {
        let v: Value =
            serde_json::from_str(&dsn_json("/vsizip/{/vsicurl/https://h/a.zip}/b.tif")).unwrap();
        assert_eq!(v["kind"], "vsi");
        assert_eq!(v["archive"], true);
        assert_eq!(v["inner"]["handler"], "vsicurl");
        assert_eq!(v["leaf"], "/vsicurl/https://h/a.zip");
        let v: Value = serde_json::from_str(&dsn_json("NETCDF:\"x.nc\":sst")).unwrap();
        assert_eq!(v["kind"], "driver");
        assert_eq!(v["subdataset"], "sst");
    }

    #[test]
    fn lowering() {
        let info = r#"{"x_size": 30, "y_size": 20, "band_types": ["Byte", "Int16"],
            "geotransform": [100, 1, 0, -10, 0, -1], "srs": "EPSG:4326", "nodata": [null, -1]}"#;
        let v: Value =
            serde_json::from_str(&lower_json("vrt://a.tif?bands=2&srcwin=4,2,20,10", info))
                .unwrap();
        assert_eq!(v["ok"], true, "{v}");
        let ds = Dataset::from_xml(v["xml"].as_str().unwrap()).unwrap();
        assert_eq!((ds.x_size, ds.y_size), (20, 10));
        let v: Value = serde_json::from_str(&lower_json("vrt://a.tif?tr=1,1", info)).unwrap();
        assert_eq!(v["ok"], false);
    }

    /// The nested corpus case through the page's resolver: four leaves, as
    /// the crate's own oracle test finds.
    #[test]
    fn nested_plan() {
        let Some(dir) = corpus() else {
            eprintln!("fixtures not found, skipping");
            return;
        };
        let base = dir.to_string_lossy().to_string();
        let xml = std::fs::read_to_string(dir.join("c09-nested.vrt")).unwrap();
        let mut vrts = serde_json::Map::new();
        for e in std::fs::read_dir(&dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "vrt") {
                vrts.insert(
                    p.to_string_lossy().to_string(),
                    json!(std::fs::read_to_string(&p).unwrap()),
                );
            }
        }
        let res = json!({"sizes": {}, "vrts": vrts}).to_string();
        let ds = Dataset::from_xml(&xml).unwrap();
        let req = [0.0, 0.0, ds.x_size as f64, ds.y_size as f64, 10.0, 7.0];
        let v: Value = serde_json::from_str(&plan_json(&xml, &base, 1, &req, &res)).unwrap();
        assert_eq!(v["ok"], true, "{v}");
        assert_eq!(v["plan"]["leaves"].as_array().unwrap().len(), 4);
        let c: Value = serde_json::from_str(&classic_json(&xml)).unwrap();
        assert_eq!(c["dataset"]["round_trip"], true);
    }
}
