//! # wxy-web
//!
//! wxylib in the browser. A COG is opened over HTTP range requests by
//! `wxy-tiff` (async-tiff underneath) and warped by `wxy-warp` onto a
//! target grid: the canvas. Rendering is warping to a screen grid, with
//! the same code the `wxy warp` command runs.
//!
//! The wasm surface is two classes. [`Cog`]: `Cog.open(url)`, then
//! `cog.warp(crs, extent, width, height, resampling)` as often as the view
//! changes. `Transform`: `new Transform(src, dst)`, then `forward` and
//! `inverse` on interleaved coordinates. CRS work is proj4rs (EPSG codes
//! and proj strings, no PROJ).
//!
//! The VRT discovery page uses free functions over [`explore`]:
//! `vrtClassic`, `vrtDsn`, `vrtLower` and `vrtPlan`, each returning JSON
//! text. They read no bytes; the page fetches and passes text in.
//!
//! The view plan page uses [`plan`]: `planView` over levels the page
//! describes, and on a [`Cog`] `levels`, `planView`, `prefetch` and
//! `warpLevel`, so a view is fetched and drawn by its plan.
//!
//! [`render`] holds the part that does not touch JavaScript, so it is
//! tested natively against the wxylib/fixtures COGs.

pub mod explore;
pub mod plan;
pub mod ranges;
pub mod render;

#[cfg(target_arch = "wasm32")]
mod fetch;

#[cfg(target_arch = "wasm32")]
mod bindings {
    use std::rc::Rc;
    use std::sync::Arc;

    use wasm_bindgen::prelude::*;
    use wxy_tiff::TiffDataset;

    use crate::fetch::FetchReader;
    use crate::plan::{self, Controls};
    use crate::render::{self, View};

    /// A view plan as the page reads it: `chunks` (`Uint32Array` of
    /// `level, col, row`, nearest the centre first), `tiles`
    /// (`Float64Array`, seven a screen tile that sees the source: `col,
    /// row, level, planned, need, visible, pole`), `cells` and
    /// `overBudget`; with `bytes` (`Float64Array`, stored bytes a chunk)
    /// when the source knows them.
    fn plan_object(
        p: &rwarp::view::ViewPlan,
        source: &rwarp::view::Source,
        bytes: Option<Vec<f64>>,
    ) -> Result<JsValue, JsValue> {
        let chunks: Vec<u32> = p
            .keys()
            .flat_map(|k| [k.level as u32, k.col as u32, k.row as u32])
            .collect();
        let cells: Vec<f64> = p
            .keys()
            .map(|k| source.levels[k.level].chunk_cells(k.col, k.row) as f64)
            .collect();
        let tiles: Vec<f64> = p
            .tiles
            .iter()
            .flat_map(|t| {
                [
                    t.col as f64,
                    t.row as f64,
                    t.level as f64,
                    t.planned as f64,
                    t.need,
                    t.valid as f64 / t.samples as f64,
                    t.pole as u8 as f64,
                ]
            })
            .collect();
        let obj = js_sys::Object::new();
        let set = |k: &str, v: JsValue| js_sys::Reflect::set(&obj, &k.into(), &v);
        set("chunks", js_sys::Uint32Array::from(&chunks[..]).into())?;
        set("chunkCells", js_sys::Float64Array::from(&cells[..]).into())?;
        set("tiles", js_sys::Float64Array::from(&tiles[..]).into())?;
        set("cells", (p.cells(source) as f64).into())?;
        set("overBudget", p.over_budget.into())?;
        if let Some(b) = bytes {
            set("bytes", js_sys::Float64Array::from(&b[..]).into())?;
        }
        Ok(obj.into())
    }

    fn controls(tile: usize, quality: f64, max_chunks: usize, single_box: bool) -> Controls {
        Controls {
            tile,
            quality,
            max_chunks,
            single_box,
        }
    }

    /// Which chunks, at which level, a `width` by `height` view of
    /// `extent` (`[xmin, xmax, ymin, ymax]`) in `view_crs` needs from a
    /// source in `source_crs` with `levels` (ten numbers a level:
    /// geotransform, size in cells, chunk shape). `tile`, `quality` and
    /// `max_chunks` are 0 for the defaults (64 pixel screen tiles, the
    /// screen's own scale, no budget); `single_box` plans one box at one
    /// level instead, the usual rule, for comparison.
    #[wasm_bindgen(js_name = planView)]
    #[allow(clippy::too_many_arguments)]
    pub fn plan_view(
        view_crs: String,
        extent: Vec<f64>,
        width: usize,
        height: usize,
        source_crs: String,
        levels: Vec<f64>,
        tile: usize,
        quality: f64,
        max_chunks: usize,
        single_box: bool,
    ) -> Result<JsValue, JsValue> {
        let err = |e: String| JsValue::from(JsError::new(&e));
        let levels = plan::levels_from_flat(&levels).map_err(err)?;
        let c = controls(tile, quality, max_chunks, single_box);
        let (p, source) =
            plan::plan(&view_crs, &extent, width, height, &source_crs, levels, &c).map_err(err)?;
        plan_object(&p, &source, None)
    }

    /// A classic VRT document as the model reads it (JSON).
    #[wasm_bindgen(js_name = vrtClassic)]
    pub fn vrt_classic(xml: String) -> String {
        crate::explore::classic_json(&xml)
    }

    /// A source name parsed into its parts (JSON).
    #[wasm_bindgen(js_name = vrtDsn)]
    pub fn vrt_dsn(name: String) -> String {
        crate::explore::dsn_json(&name)
    }

    /// A `vrt://` string lowered to classic VRT XML over a source
    /// description (JSON in, JSON out).
    #[wasm_bindgen(js_name = vrtLower)]
    pub fn vrt_lower(dsn: String, info: String) -> String {
        crate::explore::lower_json(&dsn, &info)
    }

    /// A read plan for one band of a classic VRT (JSON).
    #[wasm_bindgen(js_name = vrtPlan)]
    pub fn vrt_plan(
        xml: String,
        base: String,
        band: usize,
        req: Vec<f64>,
        resolver: String,
    ) -> String {
        crate::explore::plan_json(&xml, &base, band, &req, &resolver)
    }

    /// A pair of CRS transforms (proj4rs): EPSG codes or proj strings.
    #[wasm_bindgen]
    pub struct Transform(render::Transform);

    #[wasm_bindgen]
    impl Transform {
        #[wasm_bindgen(constructor)]
        pub fn new(src: String, dst: String) -> Result<Transform, JsError> {
            render::Transform::new(&src, &dst)
                .map(Transform)
                .map_err(|e| JsError::new(&e))
        }

        /// Interleaved `x, y` pairs from `src` to `dst` (`NaN` on failure).
        pub fn forward(&self, xy: Vec<f64>) -> Vec<f64> {
            self.0.forward(&xy)
        }

        /// Interleaved `x, y` pairs from `dst` to `src`.
        pub fn inverse(&self, xy: Vec<f64>) -> Vec<f64> {
            self.0.inverse(&xy)
        }
    }

    /// An opened COG.
    #[wasm_bindgen]
    pub struct Cog {
        ds: Rc<TiffDataset>,
        reader: Arc<FetchReader>,
    }

    #[wasm_bindgen]
    impl Cog {
        /// Open the COG at `url`: read its header and image directories
        /// with range requests. The server must allow CORS.
        pub async fn open(url: String) -> Result<Cog, JsError> {
            let reader = Arc::new(FetchReader::new(url));
            let ds = wxy_tiff::open(reader.clone())
                .await
                .map_err(|e| JsError::new(&e.to_string()))?;
            Ok(Cog {
                ds: Rc::new(ds),
                reader,
            })
        }

        /// The source as JSON: size, bands, type, CRS, geotransform,
        /// nodata, and the size of each overview.
        pub fn info(&self) -> String {
            render::info(&self.ds)
        }

        /// The levels as a `Float64Array`, ten numbers each: geotransform
        /// (6), size in cells (2), tile shape (2). Level 0 is full
        /// resolution, then the overviews.
        pub fn levels(&self) -> Result<Vec<f64>, JsError> {
            plan::cog_levels(&self.ds)
                .map(|(_, l)| plan::levels_to_flat(&l))
                .map_err(|e| JsError::new(&e))
        }

        /// The source's CRS, as the planner and the warp name it.
        #[wasm_bindgen(js_name = sourceCrs)]
        pub fn source_crs(&self) -> Result<String, JsError> {
            plan::cog_levels(&self.ds)
                .map(|(crs, _)| crs)
                .map_err(|e| JsError::new(&e))
        }

        /// `planView` for this COG's own levels, with `bytes`: what each
        /// chunk holds in the file, from the tile byte counts.
        #[wasm_bindgen(js_name = planView)]
        #[allow(clippy::too_many_arguments)]
        pub fn plan_view(
            &self,
            view_crs: String,
            extent: Vec<f64>,
            width: usize,
            height: usize,
            tile: usize,
            quality: f64,
            max_chunks: usize,
            single_box: bool,
        ) -> Result<JsValue, JsValue> {
            let err = |e: String| JsValue::from(JsError::new(&e));
            let (crs, levels) = plan::cog_levels(&self.ds).map_err(err)?;
            let c = controls(tile, quality, max_chunks, single_box);
            let (p, source) =
                plan::plan(&view_crs, &extent, width, height, &crs, levels, &c).map_err(err)?;
            let bytes = plan::stored_bytes(&self.ds, &p);
            plan_object(&p, &source, Some(bytes))
        }

        /// Fetch chunks (`level, col, row` triples, as a plan's `chunks`)
        /// in as few range requests as the merge policy allows. Resolves
        /// to `{ requests, bytes }`, the reader's totals so far. Warps
        /// that follow read these tiles from memory.
        pub fn prefetch(&self, chunks: Vec<u32>) -> js_sys::Promise {
            let ds = self.ds.clone();
            let reader = self.reader.clone();
            wasm_bindgen_futures::future_to_promise(async move {
                plan::prefetch(&ds, &chunks)
                    .await
                    .map_err(|e| JsValue::from(JsError::new(&e)))?;
                let obj = js_sys::Object::new();
                let set = |k: &str, v: JsValue| js_sys::Reflect::set(&obj, &k.into(), &v);
                let (requests, bytes) = reader.stats();
                set("requests", (requests as f64).into())?;
                set("bytes", (bytes as f64).into())?;
                Ok(obj.into())
            })
        }

        /// `warp` from a given level (0 is full resolution) instead of
        /// the one the warp would choose: how a screen tile is drawn from
        /// the level its plan gave it.
        #[wasm_bindgen(js_name = warpLevel)]
        pub fn warp_level(
            &self,
            crs: String,
            extent: Vec<f64>,
            width: usize,
            height: usize,
            resampling: String,
            level: usize,
        ) -> js_sys::Promise {
            let ds = self.ds.clone();
            let reader = self.reader.clone();
            wasm_bindgen_futures::future_to_promise(async move {
                let view = View::new(&crs, &extent, width, height, &resampling)
                    .map_err(|e| JsValue::from(JsError::new(&e)))?;
                let out = render::warp_level(&ds, &view, Some(level))
                    .await
                    .map_err(|e| JsValue::from(JsError::new(&e)))?;
                let obj = js_sys::Object::new();
                let set = |k: &str, v: JsValue| js_sys::Reflect::set(&obj, &k.into(), &v);
                set("values", js_sys::Float32Array::from(&out.values[..]).into())?;
                set("bands", out.bands.into())?;
                set("level", out.level.into())?;
                let (requests, bytes) = reader.stats();
                set("requests", (requests as f64).into())?;
                set("bytes", (bytes as f64).into())?;
                Ok(obj.into())
            })
        }

        /// The source's extent in `crs`, as `[xmin, xmax, ymin, ymax]`.
        pub fn bounds(&self, crs: String) -> Result<Vec<f64>, JsError> {
            render::bounds(&self.ds, &crs)
                .map(|b| b.to_vec())
                .map_err(|e| JsError::new(&e))
        }

        /// Warp to a `width` by `height` grid in `crs` covering `extent`
        /// (`[xmin, xmax, ymin, ymax]`), with resampling `"near"`,
        /// `"bilinear"`, `"cubic"`, `"lanczos"`, `"average"` or `"mode"`.
        /// Resolves to an object with `values`
        /// (a `Float32Array`, band by band, row by row, `NaN` where nothing
        /// maps or the source is nodata), `bands`, `level` (0 is full
        /// resolution, then overviews), and `requests` and `bytes` (range
        /// reads so far, cached reads not counted).
        pub fn warp(
            &self,
            crs: String,
            extent: Vec<f64>,
            width: usize,
            height: usize,
            resampling: String,
        ) -> js_sys::Promise {
            let ds = self.ds.clone();
            let reader = self.reader.clone();
            wasm_bindgen_futures::future_to_promise(async move {
                let view = View::new(&crs, &extent, width, height, &resampling)
                    .map_err(|e| JsValue::from(JsError::new(&e)))?;
                let out = render::warp(&ds, &view)
                    .await
                    .map_err(|e| JsValue::from(JsError::new(&e)))?;
                let obj = js_sys::Object::new();
                let set = |k: &str, v: JsValue| js_sys::Reflect::set(&obj, &k.into(), &v);
                set("values", js_sys::Float32Array::from(&out.values[..]).into())?;
                set("bands", out.bands.into())?;
                set("level", out.level.into())?;
                let (requests, bytes) = reader.stats();
                set("requests", (requests as f64).into())?;
                set("bytes", (bytes as f64).into())?;
                Ok(obj.into())
            })
        }
    }
}
