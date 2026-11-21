//! A Zarr source for the view plan page: the levels of a multiscales
//! group (or one array) as chunk sources the warp reads, so a view is
//! fetched and drawn by its plan. `wxy-zarr` (zarrs underneath) opens
//! each array and decodes its chunks; this module adds what the page
//! needs around that:
//!
//! - [`Plane`]: the last two dims of an array as a 2D chunk source, at
//!   index 0 of any dims before them (the first time step, the first
//!   band), with the decoded chunks kept, so the screen tiles that share
//!   a chunk decode it once. Told to read held chunks only, it gives
//!   every other chunk as empty and fetches nothing: the plan then
//!   decides what is read, not the warp's own (wider) source windows;
//! - [`ZarrLevels`]: one plane and one domain a level, placed by the
//!   same geotransforms the plan was made from.
//!
//! No JavaScript here, so it tests natively against wxylib/fixtures.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use futures_util::stream::{self, StreamExt, TryStreamExt};
use rwarp::view::Level;
use wxy_domain::{Affine, CellConvention, DataType, Dim, Domain, Frame, Mapping, Positions};
use wxy_source::{Chunk, ChunkGrid, ChunkKey, ChunkSource, Encoded, Error, Result, Values};
use wxy_zarr::{ZarrDataset, ZarrSource};

/// Chunk requests in flight at once.
pub const MAX_CONCURRENT: usize = 6;
/// Decoded bytes a plane keeps before it drops the oldest chunks.
pub const KEEP_BYTES: usize = 192 << 20;

/// The last two dims of a Zarr array as a 2D source, at index 0 of the
/// dims before them. Decoded chunks are kept, oldest dropped first.
pub struct Plane {
    inner: ZarrSource,
    /// The 2D grid: `[height, width]` in chunks of `[rows, cols]`.
    grid: ChunkGrid,
    lead: usize,
    kept: Mutex<Kept>,
    /// Chunks not held read as `empty`, with no fetch.
    held_only: AtomicBool,
    empty: f64,
}

#[derive(Default)]
struct Kept {
    chunks: HashMap<ChunkKey, Arc<Chunk>>,
    order: VecDeque<ChunkKey>,
    bytes: usize,
}

/// What `fetch` hands `decode`: a chunk already decoded, or the array's
/// own encoded chunk.
enum Payload {
    Kept(Arc<Chunk>),
    Fresh(Encoded),
    Empty,
}

impl Plane {
    pub fn new(inner: ZarrSource) -> Result<Self> {
        let g = inner.grid();
        let n = g.shape.len();
        if n < 2 {
            return Err(Error::Unsupported(
                "the array has fewer than two dims".into(),
            ));
        }
        let grid = ChunkGrid::new(g.shape[n - 2..].to_vec(), g.chunk[n - 2..].to_vec());
        Ok(Self {
            inner,
            grid,
            lead: n - 2,
            kept: Mutex::new(Kept::default()),
            held_only: AtomicBool::new(false),
            empty: 0.0,
        })
    }

    /// The array's own key for a plane key: chunk 0 of each leading dim.
    fn full_key(&self, key: &ChunkKey) -> ChunkKey {
        let mut k = vec![0; self.lead];
        k.extend(&key.0);
        ChunkKey(k)
    }

    /// Whether the plane holds this chunk decoded.
    pub fn holds(&self, key: &ChunkKey) -> bool {
        self.kept.lock().unwrap().chunks.contains_key(key)
    }

    fn keep(&self, chunk: &Arc<Chunk>) {
        let size = held_bytes(chunk);
        let mut k = self.kept.lock().unwrap();
        if k.chunks.insert(chunk.key.clone(), chunk.clone()).is_none() {
            k.order.push_back(chunk.key.clone());
            k.bytes += size;
        }
        while k.bytes > KEEP_BYTES && k.order.len() > 1 {
            let old = k.order.pop_front().unwrap();
            if let Some(c) = k.chunks.remove(&old) {
                k.bytes -= held_bytes(&c);
            }
        }
    }

    /// `keys` as payloads: held chunks as they are, the others fetched
    /// (`missing`) or given as empty.
    async fn fetch_with(&self, keys: &[ChunkKey], missing: bool) -> Result<Vec<Encoded>> {
        let held: Vec<Option<Arc<Chunk>>> = {
            let k = self.kept.lock().unwrap();
            keys.iter().map(|key| k.chunks.get(key).cloned()).collect()
        };
        let reads: Vec<(ChunkKey, Option<Arc<Chunk>>)> = keys.iter().cloned().zip(held).collect();
        stream::iter(reads)
            .map(|(key, held)| self.one(key, held, missing))
            .buffered(MAX_CONCURRENT)
            .try_collect()
            .await
    }

    async fn one(&self, key: ChunkKey, held: Option<Arc<Chunk>>, missing: bool) -> Result<Encoded> {
        let payload = match held {
            Some(c) => Payload::Kept(c),
            None if !missing => Payload::Empty,
            None => {
                let mut got = self.inner.fetch(&[self.full_key(&key)]).await?;
                Payload::Fresh(
                    got.pop()
                        .ok_or_else(|| Error::Fetch("the store returned no chunk".into()))?,
                )
            }
        };
        Ok(Encoded {
            key,
            payload: Box::new(payload),
        })
    }

    /// Fetch and decode `keys` (those not held), so reads that follow
    /// come from memory.
    pub async fn prefetch(&self, keys: &[ChunkKey]) -> Result<()> {
        for e in self.fetch_with(keys, true).await? {
            self.decode(e)?;
        }
        Ok(())
    }
}

fn held_bytes(c: &Chunk) -> usize {
    c.values.len() * c.values.dtype().size().unwrap_or(1)
}

/// `n` values of `dtype`, each `v`.
fn filled(dtype: DataType, n: usize, v: f64) -> Result<Values> {
    let mut out = Values::zeros(dtype, n)?;
    macro_rules! set {
        ($($t:ident),*) => {
            match &mut out {
                $(Values::$t(x) => x.fill(v as _),)*
            }
        };
    }
    set!(U8, U16, U32, U64, I8, I16, I32, I64, F32, F64);
    Ok(out)
}

/// The first plane of an N-dim chunk: its first `rows * cols` values.
fn first_plane(values: Values, n: usize) -> Values {
    macro_rules! cut {
        ($($v:ident),*) => {
            match values {
                $(Values::$v(mut x) => { x.truncate(n); Values::$v(x) })*
            }
        };
    }
    cut!(U8, U16, U32, U64, I8, I16, I32, I64, F32, F64)
}

#[cfg_attr(target_arch = "wasm32", async_trait::async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait::async_trait)]
impl ChunkSource for Plane {
    fn grid(&self) -> &ChunkGrid {
        &self.grid
    }

    fn dtype(&self) -> DataType {
        self.inner.dtype()
    }

    async fn fetch(&self, keys: &[ChunkKey]) -> Result<Vec<Encoded>> {
        self.fetch_with(keys, !self.held_only.load(Ordering::Relaxed))
            .await
    }

    fn decode(&self, encoded: Encoded) -> Result<Chunk> {
        let payload = encoded
            .payload
            .downcast::<Payload>()
            .map_err(|_| Error::Decode("payload is not a plane's chunk".into()))?;
        let full = match *payload {
            Payload::Kept(c) => return Ok((*c).clone()),
            Payload::Empty => {
                let stored = self.grid.chunk.clone();
                let cells = (stored[0] * stored[1]) as usize;
                return Ok(Chunk {
                    window: self.grid.window(&encoded.key),
                    key: encoded.key,
                    stored,
                    values: filled(self.inner.dtype(), cells, self.empty)?,
                });
            }
            Payload::Fresh(e) => self.inner.decode(e)?,
        };
        let n = full.stored.len();
        let stored = full.stored[n - 2..].to_vec();
        let cells = (stored[0] * stored[1]) as usize;
        let chunk = Arc::new(Chunk {
            window: self.grid.window(&encoded.key),
            key: encoded.key,
            stored,
            values: first_plane(full.values, cells),
        });
        self.keep(&chunk);
        Ok((*chunk).clone())
    }
}

/// The levels of a Zarr source, finest first: a plane and a domain each.
pub struct ZarrLevels {
    pub planes: Vec<Plane>,
    pub domains: Vec<Domain>,
    /// The value that stands for no data: `_FillValue`, else the arrays'
    /// `fill_value` (what a chunk never written reads as).
    pub nodata: Option<f64>,
    /// The dims of the first level's array, as `name: size`.
    pub dims: Vec<(String, u64)>,
}

impl ZarrLevels {
    /// `datasets` opened by `wxy-zarr`, one a level, placed by `levels`
    /// (the geotransforms and sizes the plan uses) in `crs`.
    pub fn new(
        datasets: Vec<ZarrDataset>,
        levels: &[Level],
        crs: &str,
    ) -> std::result::Result<Self, String> {
        if datasets.is_empty() || datasets.len() != levels.len() {
            return Err(format!(
                "{} arrays for {} levels",
                datasets.len(),
                levels.len()
            ));
        }
        wxy_warp::check_crs(crs).map_err(|e| e.to_string())?;
        let c0 = &datasets[0].collection;
        let nodata = c0.fields[0].values.nodata.or_else(|| {
            c0.attrs
                .get("zarr:fill_value")
                .and_then(|t| serde_json::from_str::<serde_json::Value>(t).ok())
                .and_then(|v| wxy_zarr::write::json_float(&v))
        });
        let dims = c0.domains[0]
            .dims
            .iter()
            .map(|d| (d.name.clone(), d.size))
            .collect();
        let mut planes = Vec::new();
        let mut domains = Vec::new();
        for (k, (ds, level)) in datasets.into_iter().zip(levels).enumerate() {
            let mut plane = Plane::new(ds.source).map_err(|e| format!("level {k}: {e}"))?;
            plane.empty = crate::render::fill(nodata, plane.dtype());
            let (h, w) = (plane.grid.shape[0], plane.grid.shape[1]);
            if [w as usize, h as usize] != level.size {
                return Err(format!(
                    "level {k}: the array is {w} x {h}, its metadata said {} x {}",
                    level.size[0], level.size[1]
                ));
            }
            let mut domain = Domain::new(vec![Dim::new("y", h), Dim::new("x", w)]);
            let m = domain.add_mapping(
                Mapping::new(
                    vec![0, 1],
                    Positions::Affine(Affine(level.gt)),
                    Frame::crs(crs),
                )
                .with_cell(CellConvention::Edge),
            );
            domain.set_primary(m);
            planes.push(plane);
            domains.push(domain);
        }
        Ok(Self {
            planes,
            domains,
            nodata,
            dims,
        })
    }

    /// Fetch and decode chunks given as `level, col, row` triples (a
    /// plan's `chunks`). Resolves to how many were not already held.
    pub async fn prefetch(&self, chunks: &[u32]) -> std::result::Result<usize, String> {
        let mut by_level: Vec<Vec<ChunkKey>> = vec![Vec::new(); self.planes.len()];
        for c in chunks.chunks_exact(3) {
            let level = by_level
                .get_mut(c[0] as usize)
                .ok_or_else(|| format!("no level {}", c[0]))?;
            level.push(ChunkKey(vec![c[2] as u64, c[1] as u64]));
        }
        let mut fresh = 0;
        for (plane, keys) in self.planes.iter().zip(&by_level) {
            let counts = plane.grid.counts();
            if let Some(k) = keys
                .iter()
                .find(|k| k.0[0] >= counts[0] || k.0[1] >= counts[1])
            {
                return Err(format!("no chunk {:?} in a grid of {counts:?}", k.0));
            }
            fresh += keys.iter().filter(|k| !plane.holds(k)).count();
            plane.prefetch(keys).await.map_err(|e| e.to_string())?;
        }
        Ok(fresh)
    }

    /// With `on`, reads take the chunks a `prefetch` brought in and give
    /// every other chunk as empty, fetching nothing: a view is then
    /// drawn from its plan's chunks alone. Off (the start), a read
    /// fetches what it lacks.
    pub fn read_held_only(&self, on: bool) {
        for p in &self.planes {
            p.held_only.store(on, Ordering::Relaxed);
        }
    }

    /// The source as a small JSON object.
    pub fn info(&self) -> String {
        let dims: Vec<String> = self
            .dims
            .iter()
            .map(|(n, s)| format!("{}: {s}", serde_json::Value::from(n.as_str())))
            .collect();
        format!(
            "{{\"dtype\": \"{:?}\", \"nodata\": {}, \"levels\": {}, \"dims\": {{{}}}}}",
            self.planes[0].dtype(),
            self.nodata
                .filter(|v| v.is_finite())
                .map_or("null".into(), |v| v.to_string()),
            self.planes.len(),
            dims.join(", ")
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{self, View};

    fn fixture(name: &str) -> Option<std::path::PathBuf> {
        let root = std::env::var("WXY_FIXTURES").unwrap_or_else(|_| "../fixtures".into());
        let p = std::path::Path::new(&root).join(name);
        p.exists().then_some(p)
    }

    fn level_of(ds: &ZarrDataset) -> (Level, String) {
        let g = wxy_warp::SourceGrid::from_domain(&ds.collection.domains[0]).unwrap();
        let grid = ds.source.grid();
        let n = grid.shape.len();
        let u = |v: u64| v as usize;
        (
            Level::new(
                g.geotransform,
                [u(grid.shape[n - 1]), u(grid.shape[n - 2])],
                [u(grid.chunk[n - 1]), u(grid.chunk[n - 2])],
            ),
            g.crs,
        )
    }

    #[tokio::test]
    async fn world_drawn_by_plan() {
        let Some(p) = fixture("zarr/world-int16-spatial.zarr") else {
            eprintln!("skipping: no fixtures checkout");
            return;
        };
        let ds = wxy_zarr::open_path(&p, "/data").await.unwrap();
        let (level, crs) = level_of(&ds);
        let z = ZarrLevels::new(vec![ds], std::slice::from_ref(&level), &crs).unwrap();
        // the plan's chunks, fetched once, then read from memory
        let r = 6.0e6;
        let extent = [-r, r, -r, r];
        let (plan, _) = crate::plan::plan(
            "EPSG:3031",
            &extent,
            128,
            128,
            &crs,
            vec![level],
            &crate::plan::Controls::default(),
        )
        .unwrap();
        let chunks: Vec<u32> = plan
            .keys()
            .flat_map(|k| [k.level as u32, k.col as u32, k.row as u32])
            .collect();
        assert!(!chunks.is_empty());
        assert_eq!(z.prefetch(&chunks).await.unwrap(), chunks.len() / 3);
        assert_eq!(z.prefetch(&chunks).await.unwrap(), 0);
        let view = View::new("EPSG:3031", &extent, 128, 128, "bilinear").unwrap();
        let out = render::warp_source(&z.planes[0], &z.domains[0], &view, z.nodata)
            .await
            .unwrap();
        assert_eq!(out.bands, 1);
        assert!(out.values[64 * 128 + 64].is_finite());
        let held = || z.planes[0].kept.lock().unwrap().chunks.len();
        let loose = held();
        assert!(loose >= chunks.len() / 3);
        // from the plan's chunks alone: the same picture
        let (ds, _) = (wxy_zarr::open_path(&p, "/data").await.unwrap(), ());
        let (level, crs) = level_of(&ds);
        let strict = ZarrLevels::new(vec![ds], &[level], &crs).unwrap();
        strict.prefetch(&chunks).await.unwrap();
        strict.read_held_only(true);
        let planned =
            render::warp_source(&strict.planes[0], &strict.domains[0], &view, strict.nodata)
                .await
                .unwrap();
        assert_eq!(
            strict.planes[0].kept.lock().unwrap().chunks.len(),
            chunks.len() / 3
        );
        let differ = out
            .values
            .iter()
            .zip(&planned.values)
            .filter(|(a, b)| a.to_bits() != b.to_bits())
            .count();
        assert_eq!(
            differ,
            0,
            "{loose} chunks read loose, {} planned",
            chunks.len() / 3
        );
    }

    #[tokio::test]
    async fn first_band_of_three() {
        let Some(p) = fixture("zarr/utm-u16-3band-node.zarr") else {
            eprintln!("skipping: no fixtures checkout");
            return;
        };
        let ds = wxy_zarr::open_path(&p, "/data").await.unwrap();
        let full = ds.source.grid().clone();
        assert_eq!(full.shape.len(), 3);
        let first = wxy_source::read_window(
            &ds.source,
            &wxy_source::Window::new(vec![0, 0, 0], vec![1, full.shape[1], full.shape[2]]),
        )
        .await
        .unwrap();
        let (level, crs) = level_of(&ds);
        let z = ZarrLevels::new(vec![ds], &[level], &crs).unwrap();
        let plane = &z.planes[0];
        assert_eq!(plane.grid().shape, full.shape[1..]);
        let got = wxy_source::read_window(
            plane,
            &wxy_source::Window::new(vec![0, 0], full.shape[1..].to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(got.values, first.values);
        assert!(z.info().contains("\"levels\": 1"), "{}", z.info());
    }
}
