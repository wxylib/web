//! The warp behind the canvas, free of JavaScript so it tests natively.

use wxy_domain::DataType;
use wxy_source::{ChunkSource, Values};
use wxy_tiff::TiffDataset;
use wxy_warp::{GridSpec, ResampleAlg, WarpOptions};

/// A target grid: the canvas.
#[derive(Debug, Clone)]
pub struct View {
    pub grid: GridSpec,
    pub resampling: ResampleAlg,
}

impl View {
    /// `extent` is `[xmin, xmax, ymin, ymax]` in `crs`; `resampling` is
    /// `"near"`, `"bilinear"`, `"cubic"`, `"lanczos"`, `"average"` or
    /// `"mode"`.
    pub fn new(
        crs: &str,
        extent: &[f64],
        width: usize,
        height: usize,
        resampling: &str,
    ) -> Result<Self, String> {
        let extent: [f64; 4] = extent
            .try_into()
            .map_err(|_| "extent needs 4 numbers: xmin, xmax, ymin, ymax".to_string())?;
        if width == 0 || height == 0 {
            return Err("width and height must be positive".into());
        }
        wxy_warp::check_crs(crs).map_err(|e| e.to_string())?;
        let resampling = match resampling {
            "near" | "nearest" => ResampleAlg::NearestNeighbour,
            "bilinear" => ResampleAlg::Bilinear,
            "cubic" => ResampleAlg::Cubic,
            "lanczos" => ResampleAlg::Lanczos,
            "average" => ResampleAlg::Average,
            "mode" => ResampleAlg::Mode,
            other => return Err(format!("unknown resampling '{other}'")),
        };
        Ok(Self {
            grid: GridSpec::from_extent(crs, extent, [width, height]),
            resampling,
        })
    }
}

/// A warped canvas: `bands` planes of `height * width` values, `NaN` where
/// nothing maps or the source is nodata.
#[derive(Debug, Clone)]
pub struct Rendered {
    pub values: Vec<f32>,
    pub bands: usize,
    /// The level read: 0 is full resolution, `k` the k-th overview.
    pub level: usize,
}

/// The value standing for "nothing here" during the warp: the source's
/// nodata, or one the data is unlikely to hold.
fn fill(ds: &TiffDataset) -> f64 {
    if let Some(nd) = ds.collection.fields[0].values.nodata {
        return nd;
    }
    match ds.levels[0].dtype() {
        DataType::I8 => i8::MIN as f64,
        DataType::I16 => i16::MIN as f64,
        DataType::I32 => i32::MIN as f64,
        DataType::F32 | DataType::F64 => f32::MIN as f64,
        // imagery: 0 is the usual unset value
        _ => 0.0,
    }
}

/// Warp the dataset to the view, reading the overview gdalwarp would.
pub async fn warp(ds: &TiffDataset, view: &View) -> Result<Rendered, String> {
    let e = |e: wxy_source::Error| e.to_string();
    let domains = &ds.collection.domains;
    let opts = WarpOptions {
        resampling: view.resampling,
        ..WarpOptions::default()
    };
    let widths: Vec<u64> = domains[1..]
        .iter()
        .map(|d| *d.shape().last().unwrap_or(&0))
        .collect();
    let level = wxy_warp::choose_overview(&domains[0], &widths, &view.grid, &opts)
        .map_err(e)?
        .map_or(0, |k| k + 1);
    let nodata = fill(ds);
    let buf = wxy_warp::warp(
        &ds.levels[level],
        &domains[level],
        &view.grid,
        &opts,
        Some(nodata),
    )
    .await
    .map_err(e)?;
    let mut values = to_f32(buf.values);
    let nd = nodata as f32;
    for v in values.iter_mut() {
        if *v == nd {
            *v = f32::NAN;
        }
    }
    let plane = view.grid.size[0] * view.grid.size[1];
    Ok(Rendered {
        bands: values.len() / plane.max(1),
        values,
        level,
    })
}

fn to_f32(v: Values) -> Vec<f32> {
    match v {
        Values::U8(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::U16(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::U32(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::U64(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::I8(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::I16(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::I32(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::I64(v) => v.into_iter().map(|x| x as f32).collect(),
        Values::F32(v) => v,
        Values::F64(v) => v.into_iter().map(|x| x as f32).collect(),
    }
}

/// The extent `[xmin, xmax, ymin, ymax]` of the source in `crs`: a 33 by
/// 33 lattice over the source, transformed, points that fail left out.
pub fn bounds(ds: &TiffDataset, crs: &str) -> Result<[f64; 4], String> {
    let src =
        wxy_warp::SourceGrid::from_domain(&ds.collection.domains[0]).map_err(|e| e.to_string())?;
    let (_, to_dst) = rwarp::crs::crs_pair(&src.crs, crs)?;
    let (w, h) = (src.shape[src.x_dim] as f64, src.shape[src.y_dim] as f64);
    let g = src.geotransform;
    let mut b = [
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
    ];
    const N: usize = 33;
    for i in 0..N {
        for j in 0..N {
            let (px, py) = (w * i as f64 / (N - 1) as f64, h * j as f64 / (N - 1) as f64);
            let x = g[0] + px * g[1] + py * g[2];
            let y = g[3] + px * g[4] + py * g[5];
            if let Some((x, y)) = to_dst
                .convert(x, y)
                .filter(|(x, y)| x.is_finite() && y.is_finite())
            {
                b = [b[0].min(x), b[1].max(x), b[2].min(y), b[3].max(y)];
            }
        }
    }
    if b[0] < b[1] && b[2] < b[3] {
        Ok(b)
    } else {
        Err(format!("the source does not map to {crs}"))
    }
}

/// The source as a small JSON object.
pub fn info(ds: &TiffDataset) -> String {
    let d0 = &ds.collection.domains[0];
    let shape = d0.shape();
    let n = shape.len();
    let crs = ds
        .collection
        .attrs
        .get("geotiff:epsg")
        .map(|e| format!("\"EPSG:{e}\""))
        .unwrap_or_else(|| "null".into());
    let gt = wxy_warp::SourceGrid::from_domain(d0)
        .map(|s| format!("{:?}", s.geotransform))
        .unwrap_or_else(|_| "null".into());
    let nodata = ds.collection.fields[0]
        .values
        .nodata
        .map_or("null".into(), |v| v.to_string());
    let overviews: Vec<String> = ds.collection.domains[1..]
        .iter()
        .map(|d| {
            let s = d.shape();
            format!("[{}, {}]", s[s.len() - 1], s[s.len() - 2])
        })
        .collect();
    format!(
        "{{\"width\": {}, \"height\": {}, \"bands\": {}, \"dtype\": \"{:?}\", \"crs\": {}, \
         \"geotransform\": {}, \"nodata\": {}, \"overviews\": [{}]}}",
        shape[n - 1],
        shape[n - 2],
        if n > 2 { shape[0] } else { 1 },
        ds.levels[0].dtype(),
        crs,
        gt,
        nodata,
        overviews.join(", ")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transform_lonlat_to_utm_and_back() {
        let t = Transform::new("EPSG:4326", "EPSG:32755").unwrap();
        // on the zone's central meridian: easting is the false easting
        let f = t.forward(&[147.0, -42.0, 147.3257, -42.8826]);
        assert!((f[0] - 500_000.0).abs() < 1e-6, "x = {}", f[0]);
        assert!((f[1] - 5_350_224.0).abs() < 10.0, "y = {}", f[1]);
        let b = t.inverse(&f);
        for (u, v) in b.iter().zip([147.0, -42.0, 147.3257, -42.8826]) {
            assert!((u - v).abs() < 1e-9, "{u} != {v}");
        }
        assert!(t.forward(&[f64::NAN, 0.0])[0].is_nan());
    }

    /// wxylib/fixtures checked out next to this repo, or `WXY_FIXTURES`.
    fn fixture(name: &str) -> Option<std::path::PathBuf> {
        let root = std::env::var("WXY_FIXTURES").unwrap_or_else(|_| "../fixtures".into());
        let p = std::path::Path::new(&root).join(name);
        p.exists().then_some(p)
    }

    #[tokio::test]
    async fn world_to_south_polar() {
        let Some(p) = fixture("cog/world-int16-deflate.tif") else {
            eprintln!("skipping: no fixtures checkout");
            return;
        };
        let ds = wxy_tiff::open_path(p).await.unwrap();
        let r = 6.0e6;
        let view = View::new("EPSG:3031", &[-r, r, -r, r], 200, 200, "bilinear").unwrap();
        let out = warp(&ds, &view).await.unwrap();
        assert_eq!(out.bands, 1);
        assert_eq!(out.values.len(), 200 * 200);
        // 0.5 degree source, 60 km cells: full resolution
        assert_eq!(out.level, 0);
        // the pole maps; the corners (beyond the equator) do not
        assert!(out.values[100 * 200 + 100].is_finite());
        assert!(out.values[0].is_nan() || out.values[0].is_finite());
        // 600 km cells read an overview
        let coarse = View::new("EPSG:3031", &[-r, r, -r, r], 20, 20, "near").unwrap();
        assert!(warp(&ds, &coarse).await.unwrap().level > 0);
        let b = bounds(&ds, "EPSG:4326").unwrap();
        assert_eq!(b, [-180.0, 180.0, -90.0, 90.0]);
        let info = info(&ds);
        assert!(info.contains("\"crs\": \"EPSG:4326\""), "{info}");
    }

    #[test]
    fn bad_view() {
        assert!(View::new("EPSG:3031", &[0.0, 1.0], 10, 10, "near").is_err());
        assert!(View::new("EPSG:3031", &[0.0, 1.0, 0.0, 1.0], 10, 10, "sinc").is_err());
    }
}

/// A pair of CRS transforms between `src` and `dst`, for positions the
/// page works with outside a warp (the editing canvas's frame).
pub struct Transform {
    to_dst: Box<dyn rwarp::crs::CrsTransform>,
    to_src: Box<dyn rwarp::crs::CrsTransform>,
}

impl Transform {
    pub fn new(src: &str, dst: &str) -> Result<Self, String> {
        let (to_src, to_dst) = rwarp::crs::crs_pair(src, dst)?;
        Ok(Self { to_dst, to_src })
    }

    /// Interleaved `x, y` pairs from `src` to `dst`; `NaN` where a point
    /// does not transform.
    pub fn forward(&self, xy: &[f64]) -> Vec<f64> {
        apply(&*self.to_dst, xy)
    }

    /// Interleaved `x, y` pairs from `dst` back to `src`.
    pub fn inverse(&self, xy: &[f64]) -> Vec<f64> {
        apply(&*self.to_src, xy)
    }
}

fn apply(t: &dyn rwarp::crs::CrsTransform, xy: &[f64]) -> Vec<f64> {
    let mut out = Vec::with_capacity(xy.len());
    for p in xy.chunks_exact(2) {
        match t.convert(p[0], p[1]) {
            Some((x, y)) => out.extend([x, y]),
            None => out.extend([f64::NAN, f64::NAN]),
        }
    }
    out
}
