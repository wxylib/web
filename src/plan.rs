//! Which chunks a view needs, before anything is fetched: `rwarp::view`
//! for the page. A source is a list of levels (geotransform, size, chunk
//! shape), from an opened COG or from metadata the page read itself (a
//! Zarr's multiscales). No JavaScript here, so it tests natively.

use rwarp::view::{
    plan_single_box, plan_view, ChunkKey, Level, Source, View, ViewOptions, ViewPlan,
};
use wxy_source::ChunkSource;
use wxy_tiff::TiffDataset;

/// What the page sets on a plan. Zero means the planner's default.
#[derive(Debug, Clone, Copy, Default)]
pub struct Controls {
    /// Screen tile size in pixels (default 64).
    pub tile: usize,
    /// Below 1 asks for finer levels than the screen shows (default 1).
    pub quality: f64,
    /// The most chunks the plan may hold (0: no budget).
    pub max_chunks: usize,
    /// One box and one level for the whole view, the usual rule, instead.
    pub single_box: bool,
}

impl Controls {
    fn options(&self) -> ViewOptions {
        let mut o = ViewOptions::default();
        if self.tile > 0 {
            o = o.with_tile(self.tile);
        }
        if self.quality.is_finite() && self.quality > 0.0 {
            o = o.with_quality(self.quality);
        }
        o.with_max_chunks((self.max_chunks > 0).then_some(self.max_chunks))
    }
}

/// Levels from a flat array, ten numbers a level: the geotransform
/// `[x0, dx, rx, y0, ry, dy]`, the size `[width, height]` in cells and
/// the chunk shape `[width, height]`.
pub fn levels_from_flat(levels: &[f64]) -> Result<Vec<Level>, String> {
    if levels.is_empty() || levels.len() % 10 != 0 {
        return Err(format!(
            "levels need 10 numbers each (geotransform, size, chunk), got {}",
            levels.len()
        ));
    }
    levels
        .chunks(10)
        .enumerate()
        .map(|(i, l)| {
            if l[6..].iter().any(|v| !(v.is_finite() && *v >= 1.0)) {
                return Err(format!("level {i}: size and chunk must be 1 or more"));
            }
            let n = |v: f64| v as usize;
            Ok(Level::new(
                [l[0], l[1], l[2], l[3], l[4], l[5]],
                [n(l[6]), n(l[7])],
                [n(l[8]), n(l[9])],
            ))
        })
        .collect()
}

/// The same ten numbers a level, from levels.
pub fn levels_to_flat(levels: &[Level]) -> Vec<f64> {
    levels
        .iter()
        .flat_map(|l| {
            let mut v = l.gt.to_vec();
            v.extend([l.size[0], l.size[1], l.chunk[0], l.chunk[1]].map(|n| n as f64));
            v
        })
        .collect()
}

/// A COG's CRS and its levels: full resolution, then each overview.
pub fn cog_levels(ds: &TiffDataset) -> Result<(String, Vec<Level>), String> {
    let mut crs = String::new();
    let mut out = Vec::new();
    for (domain, level) in ds.collection.domains.iter().zip(&ds.levels) {
        let grid = wxy_warp::SourceGrid::from_domain(domain).map_err(|e| e.to_string())?;
        if crs.is_empty() {
            crs = grid.crs.clone();
        }
        let g = level.grid();
        let n = g.rank();
        out.push(Level::new(
            grid.geotransform,
            [g.shape[n - 1] as usize, g.shape[n - 2] as usize],
            [g.chunk[n - 1] as usize, g.chunk[n - 2] as usize],
        ));
    }
    Ok((crs, out))
}

/// Plan a `width` by `height` view of `extent` (`[xmin, xmax, ymin,
/// ymax]`, as the rest of this crate) in `view_crs` over `levels` in
/// `source_crs`.
pub fn plan(
    view_crs: &str,
    extent: &[f64],
    width: usize,
    height: usize,
    source_crs: &str,
    levels: Vec<Level>,
    controls: &Controls,
) -> Result<(ViewPlan, Source), String> {
    let [x0, x1, y0, y1]: [f64; 4] = extent
        .try_into()
        .map_err(|_| "extent needs 4 numbers: xmin, xmax, ymin, ymax".to_string())?;
    if !(x1 > x0 && y1 > y0) || width == 0 || height == 0 {
        return Err("the view is empty".into());
    }
    let view = View::new([x0, y0, x1, y1], [width, height]);
    let source = Source::for_crs(levels, source_crs)?;
    let (to_source, to_view) = rwarp::crs::crs_pair(source_crs, view_crs)?;
    let plan = if controls.single_box {
        plan_single_box(&view, &source, &to_source, Some(&to_view), 64, 0.7)
    } else {
        plan_view(
            &view,
            &source,
            &to_source,
            Some(&to_view),
            &controls.options(),
        )
    };
    Ok((plan, source))
}

fn tiff_key(k: &ChunkKey) -> wxy_source::ChunkKey {
    wxy_source::ChunkKey(vec![0, k.row as u64, k.col as u64])
}

/// The stored (compressed) bytes of each of the plan's chunks in a COG,
/// from its tile byte counts: known without a fetch.
pub fn stored_bytes(ds: &TiffDataset, plan: &ViewPlan) -> Vec<f64> {
    plan.keys()
        .map(|k| ds.levels[k.level].stored_bytes(&tiff_key(&k)).unwrap_or(0) as f64)
        .collect()
}

/// Fetch chunks of a COG, given as `level, col, row` triples, level by
/// level, each level as one batch. The reader keeps what it fetches, so
/// warps that follow find their tiles in memory.
pub async fn prefetch(ds: &TiffDataset, chunks: &[u32]) -> Result<usize, String> {
    let mut n = 0;
    for level in 0..ds.levels.len() {
        let keys: Vec<wxy_source::ChunkKey> = chunks
            .chunks_exact(3)
            .filter(|c| c[0] as usize == level)
            .map(|c| wxy_source::ChunkKey(vec![0, c[2] as u64, c[1] as u64]))
            .collect();
        if keys.is_empty() {
            continue;
        }
        n += keys.len();
        ds.levels[level]
            .fetch(&keys)
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mur() -> Vec<Level> {
        Level::new(
            [-180.0, 0.01, 0.0, 90.0, 0.0, -0.01],
            [36000, 18000],
            [512, 512],
        )
        .pyramid(7)
    }

    #[test]
    fn polar_view_of_a_lonlat_pyramid() {
        let r = 4.0e6;
        let c = Controls::default();
        let (p, src) = plan(
            "EPSG:3031",
            &[-r, r, -r, r],
            1024,
            1024,
            "EPSG:4326",
            mur(),
            &c,
        )
        .unwrap();
        let single = Controls {
            single_box: true,
            ..c
        };
        let (s, _) = plan(
            "EPSG:3031",
            &[-r, r, -r, r],
            1024,
            1024,
            "EPSG:4326",
            mur(),
            &single,
        )
        .unwrap();
        assert_eq!(src.period, Some(360.0));
        assert_eq!((p.chunks.len(), s.chunks.len()), (36, 216));
        assert!(s.cells(&src) > 6 * p.cells(&src));
        let tight = Controls {
            max_chunks: 12,
            ..c
        };
        let (t, _) = plan(
            "EPSG:3031",
            &[-r, r, -r, r],
            1024,
            1024,
            "EPSG:4326",
            mur(),
            &tight,
        )
        .unwrap();
        assert!(t.chunks.len() <= 12);
    }

    #[test]
    fn flat_levels_round_trip() {
        let flat = levels_to_flat(&mur());
        assert_eq!(flat.len(), 70);
        assert_eq!(levels_from_flat(&flat).unwrap(), mur());
        assert!(levels_from_flat(&flat[..9]).is_err());
        assert!(plan(
            "EPSG:3031",
            &[0.0, 1.0],
            8,
            8,
            "EPSG:4326",
            mur(),
            &Controls::default()
        )
        .is_err());
        assert!(plan(
            "EPSG:3031",
            &[0.0, 0.0, 1.0, 1.0],
            8,
            8,
            "EPSG:4326",
            mur(),
            &Controls::default()
        )
        .is_err());
    }

    fn fixture(name: &str) -> Option<std::path::PathBuf> {
        let root = std::env::var("WXY_FIXTURES").unwrap_or_else(|_| "../fixtures".into());
        let p = std::path::Path::new(&root).join(name);
        p.exists().then_some(p)
    }

    #[tokio::test]
    async fn a_cog_planned_fetched_and_warped_by_level() {
        let Some(p) = fixture("cog/world-int16-deflate.tif") else {
            eprintln!("skipping: no fixtures checkout");
            return;
        };
        let ds = wxy_tiff::open_path(p).await.unwrap();
        let (crs, levels) = cog_levels(&ds).unwrap();
        assert_eq!(crs, "EPSG:4326");
        assert_eq!(levels.len(), ds.levels.len());
        assert_eq!(levels[0].size, [720, 360]);
        assert!(levels.len() > 1 && levels[1].cell() > levels[0].cell());

        let r = 6.0e6;
        let (plan, _) = plan(
            "EPSG:3031",
            &[-r, r, -r, r],
            256,
            256,
            &crs,
            levels,
            &Controls::default(),
        )
        .unwrap();
        assert!(!plan.chunks.is_empty());
        let bytes = stored_bytes(&ds, &plan);
        assert_eq!(bytes.len(), plan.chunks.len());
        assert!(bytes.iter().all(|b| *b > 0.0));
        let flat: Vec<u32> = plan
            .keys()
            .flat_map(|k| [k.level as u32, k.col as u32, k.row as u32])
            .collect();
        assert_eq!(prefetch(&ds, &flat).await.unwrap(), plan.chunks.len());

        // One screen tile, warped from the level the plan gave it, is the
        // same as the warp choosing for itself when they agree on a level.
        let t = plan
            .tiles
            .iter()
            .find(|t| t.col == 2 && t.row == 2)
            .unwrap();
        let s = 2.0 * r / 256.0;
        let e = [-r + 128.0 * s, -r + 192.0 * s, r - 192.0 * s, r - 128.0 * s];
        let view = crate::render::View::new("EPSG:3031", &e, 64, 64, "bilinear").unwrap();
        let fixed = crate::render::warp_level(&ds, &view, Some(t.planned))
            .await
            .unwrap();
        assert_eq!(fixed.level, t.planned);
        assert!(fixed.values.iter().any(|v| v.is_finite()));
        let auto = crate::render::warp(&ds, &view).await.unwrap();
        if auto.level == fixed.level {
            assert_eq!(auto.values.len(), fixed.values.len());
            assert!(auto
                .values
                .iter()
                .zip(&fixed.values)
                .all(|(a, b)| a == b || (a.is_nan() && b.is_nan())));
        }
        assert!(crate::render::warp_level(&ds, &view, Some(99))
            .await
            .is_err());
    }
}
