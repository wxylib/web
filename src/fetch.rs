//! An async-tiff reader over the browser's `fetch`, with range requests.
//!
//! Each range read is cached, so panning and zooming re-reads tiles from
//! memory rather than the network. A batch of tile reads is merged into
//! as few requests as the policy in [`crate::ranges`] allows, with up to
//! six in flight at once. `fetch` is called on the global object, so this
//! works on a page and in a worker.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::Mutex;

use async_tiff::error::{AsyncTiffError, AsyncTiffResult};
use async_tiff::reader::AsyncFileReader;
use bytes::Bytes;
use futures_util::stream::{self, StreamExt};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;

use crate::ranges;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = fetch)]
    fn fetch_with_request(req: &web_sys::Request) -> js_sys::Promise;
}

#[derive(Debug)]
pub struct FetchReader {
    url: String,
    cache: Mutex<HashMap<(u64, u64), Bytes>>,
    /// Network requests and bytes received.
    stats: Mutex<(u64, u64)>,
}

impl FetchReader {
    pub fn new(url: String) -> Self {
        Self {
            url,
            cache: Mutex::new(HashMap::new()),
            stats: Mutex::new((0, 0)),
        }
    }

    pub fn stats(&self) -> (u64, u64) {
        *self.stats.lock().unwrap()
    }

    async fn fetch(&self, range: Range<u64>) -> Result<Bytes, String> {
        let js = |e: JsValue| match e.dyn_ref::<js_sys::Error>() {
            Some(err) => format!("{} ({})", String::from(err.message()), self.url),
            None => e.as_string().unwrap_or_else(|| format!("{e:?}")),
        };
        let init = web_sys::RequestInit::new();
        init.set_method("GET");
        let req = web_sys::Request::new_with_str_and_init(&self.url, &init).map_err(js)?;
        req.headers()
            .set("Range", &format!("bytes={}-{}", range.start, range.end - 1))
            .map_err(js)?;
        let resp: web_sys::Response = JsFuture::from(fetch_with_request(&req))
            .await
            .map_err(js)?
            .dyn_into()
            .map_err(js)?;
        if !resp.ok() {
            return Err(format!("HTTP {} for {}", resp.status(), self.url));
        }
        let buf = JsFuture::from(resp.array_buffer().map_err(js)?)
            .await
            .map_err(js)?;
        let mut bytes = js_sys::Uint8Array::new(&buf).to_vec();
        let want = (range.end - range.start) as usize;
        if resp.status() == 200 && bytes.len() > want {
            // the server ignored Range and sent the whole file
            let end = (range.end as usize).min(bytes.len());
            bytes = bytes[(range.start as usize).min(end)..end].to_vec();
        }
        Ok(Bytes::from(bytes))
    }
}

#[async_trait::async_trait(?Send)]
impl AsyncFileReader for FetchReader {
    async fn get_bytes(&self, range: Range<u64>) -> AsyncTiffResult<Bytes> {
        let key = (range.start, range.end);
        if let Some(b) = self.cache.lock().unwrap().get(&key) {
            return Ok(b.clone());
        }
        let b = self.fetch(range).await.map_err(AsyncTiffError::General)?;
        {
            let mut s = self.stats.lock().unwrap();
            s.0 += 1;
            s.1 += b.len() as u64;
        }
        self.cache.lock().unwrap().insert(key, b.clone());
        Ok(b)
    }

    async fn get_byte_ranges(&self, wanted: Vec<Range<u64>>) -> AsyncTiffResult<Vec<Bytes>> {
        let mut out: Vec<Option<Bytes>> = {
            let cache = self.cache.lock().unwrap();
            wanted
                .iter()
                .map(|r| cache.get(&(r.start, r.end)).cloned())
                .collect()
        };
        let missing: Vec<usize> = (0..wanted.len()).filter(|&i| out[i].is_none()).collect();
        let reads: Vec<Range<u64>> = missing.iter().map(|&i| wanted[i].clone()).collect();
        let merged = ranges::merge(
            &reads,
            ranges::MAX_REQUEST_BYTES,
            ranges::MAX_OVERFETCH_BYTES,
        );
        // in order, at most MAX_CONCURRENT requests at once
        let fetched: Vec<Result<Bytes, String>> = stream::iter(merged.iter())
            .map(|m| self.fetch(m.range.clone()))
            .buffered(ranges::MAX_CONCURRENT)
            .collect()
            .await;
        for (m, body) in merged.iter().zip(fetched) {
            let body = body.map_err(AsyncTiffError::General)?;
            {
                let mut s = self.stats.lock().unwrap();
                s.0 += 1;
                s.1 += body.len() as u64;
            }
            let mut cache = self.cache.lock().unwrap();
            for &j in &m.members {
                let r = &reads[j];
                let lo = (r.start - m.range.start) as usize;
                let hi = (r.end - m.range.start) as usize;
                if hi > body.len() {
                    return Err(AsyncTiffError::General(format!(
                        "short read of {} bytes for {}..{} ({})",
                        body.len(),
                        m.range.start,
                        m.range.end,
                        self.url
                    )));
                }
                let b = body.slice(lo..hi);
                cache.insert((r.start, r.end), b.clone());
                out[missing[j]] = Some(b);
            }
        }
        Ok(out.into_iter().map(|b| b.unwrap()).collect())
    }
}
