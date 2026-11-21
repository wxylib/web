//! A zarrs store over the browser's `fetch`: a key is a GET of
//! `base/key`, a missing key (404, or the 403 some object stores answer
//! for one) is `None`, and a partial read is a range request. Requests
//! and bytes received are counted for the page.

use std::sync::Mutex;

use futures_util::stream::{self, StreamExt};
use wasm_bindgen::prelude::*;
use wasm_bindgen::JsCast;
use wasm_bindgen_futures::JsFuture;
use zarrs_storage::byte_range::{ByteRange, ByteRangeIterator};
use zarrs_storage::{
    AsyncMaybeBytesIterator, AsyncReadableStorageTraits, Bytes, MaybeBytes, StorageError, StoreKey,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_name = fetch)]
    fn fetch_with_request(req: &web_sys::Request) -> js_sys::Promise;
}

#[derive(Debug)]
pub struct FetchStore {
    base: String,
    /// Network requests and bytes received.
    stats: Mutex<(u64, u64)>,
}

impl FetchStore {
    /// `base` is the URL of the Zarr hierarchy's root.
    pub fn new(base: &str) -> Self {
        Self {
            base: base.trim_end_matches('/').to_string(),
            stats: Mutex::new((0, 0)),
        }
    }

    pub fn stats(&self) -> (u64, u64) {
        *self.stats.lock().unwrap()
    }

    /// GET `key`, whole or one range of it. `None`: no such key.
    async fn read(&self, key: &StoreKey, range: Option<ByteRange>) -> Result<MaybeBytes, String> {
        let url = format!("{}/{}", self.base, key.as_str());
        let js = |e: JsValue| match e.dyn_ref::<js_sys::Error>() {
            Some(err) => format!("{} ({url})", String::from(err.message())),
            None => e.as_string().unwrap_or_else(|| format!("{e:?}")),
        };
        let init = web_sys::RequestInit::new();
        init.set_method("GET");
        let req = web_sys::Request::new_with_str_and_init(&url, &init).map_err(js)?;
        let header = match range {
            None | Some(ByteRange::FromStart(0, None)) => None,
            Some(ByteRange::FromStart(o, None)) => Some(format!("bytes={o}-")),
            Some(ByteRange::FromStart(o, Some(n))) => Some(format!("bytes={o}-{}", o + n - 1)),
            Some(ByteRange::Suffix(n)) => Some(format!("bytes=-{n}")),
        };
        if let Some(h) = &header {
            req.headers().set("Range", h).map_err(js)?;
        }
        let resp: web_sys::Response = JsFuture::from(fetch_with_request(&req))
            .await
            .map_err(js)?
            .dyn_into()
            .map_err(js)?;
        if resp.status() == 404 || resp.status() == 403 {
            return Ok(None);
        }
        if !resp.ok() {
            return Err(format!("HTTP {} for {url}", resp.status()));
        }
        let buf = JsFuture::from(resp.array_buffer().map_err(js)?)
            .await
            .map_err(js)?;
        let mut bytes = js_sys::Uint8Array::new(&buf).to_vec();
        {
            let mut s = self.stats.lock().unwrap();
            s.0 += 1;
            s.1 += bytes.len() as u64;
        }
        if header.is_some() && resp.status() == 200 {
            // the server ignored Range and sent the whole value
            let len = bytes.len() as u64;
            let (lo, hi) = match range {
                Some(ByteRange::FromStart(o, n)) => {
                    (o.min(len), n.map_or(len, |n| (o + n).min(len)))
                }
                Some(ByteRange::Suffix(n)) => (len.saturating_sub(n), len),
                None => (0, len),
            };
            bytes = bytes[lo as usize..hi as usize].to_vec();
        }
        Ok(Some(Bytes::from(bytes)))
    }
}

#[async_trait::async_trait(?Send)]
impl AsyncReadableStorageTraits for FetchStore {
    async fn get(&self, key: &StoreKey) -> Result<MaybeBytes, StorageError> {
        self.read(key, None).await.map_err(StorageError::Other)
    }

    async fn get_partial_many<'a>(
        &'a self,
        key: &StoreKey,
        byte_ranges: ByteRangeIterator<'a>,
    ) -> Result<AsyncMaybeBytesIterator<'a>, StorageError> {
        let mut out = Vec::new();
        for r in byte_ranges {
            match self.read(key, Some(r)).await.map_err(StorageError::Other)? {
                Some(b) => out.push(Ok(b)),
                None => return Ok(None),
            }
        }
        Ok(Some(stream::iter(out).boxed()))
    }

    async fn size_key(&self, _key: &StoreKey) -> Result<Option<u64>, StorageError> {
        Err(StorageError::Other("sizes are not read over fetch".into()))
    }

    fn supports_get_partial(&self) -> bool {
        true
    }
}
