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
//! [`render`] holds the part that does not touch JavaScript, so it is
//! tested natively against the wxylib/fixtures COGs.

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
    use crate::render::{self, View};

    /// A pair of CRS transforms (proj4rs): EPSG codes or proj strings.
    #[wasm_bindgen]
    pub struct Transform(render::Transform);

    #[wasm_bindgen]
    impl Transform {
        #[wasm_bindgen(constructor)]
        pub fn new(src: String, dst: String) -> Result<Transform, JsError> {
            render::Transform::new(&src, &dst).map(Transform).map_err(|e| JsError::new(&e))
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
