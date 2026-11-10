//! Merging byte-range reads into fewer requests.
//!
//! A COG written by GDAL stores the tiles of each level in row-major
//! order, so the tiles a view needs form a few runs of adjacent ranges.
//! Browsers open at most six HTTP/1.1 connections per host, and S3 does
//! not offer HTTP/2 to browsers, so one request per tile waits in a
//! queue. Merging the reads of one batch into one request per run
//! removes most of that queue.
//!
//! The policy follows `@developmentseed/range-reader` (deck.gl-raster
//! 0.10): reads are taken in offset order; a read that overlaps the
//! current request always joins it; a read past its end joins only if
//! the gap is at most the median read length, the merged request stays
//! within `max_request` bytes, and the bytes merged across stay within
//! `max_overfetch`.

use std::ops::Range;

/// Largest merged request, in bytes.
pub const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
/// Largest total gap merged across in one request, in bytes.
pub const MAX_OVERFETCH_BYTES: u64 = 1024 * 1024;
/// Requests in flight at once: the browser's HTTP/1.1 limit per host.
pub const MAX_CONCURRENT: usize = 6;

/// One request and the reads it serves, by their index in the input.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merged {
    pub range: Range<u64>,
    pub members: Vec<usize>,
    /// Bytes fetched that no member asked for.
    pub overfetch: u64,
}

fn median_len(reads: &[Range<u64>]) -> u64 {
    let mut lens: Vec<u64> = reads.iter().map(|r| r.end - r.start).collect();
    if lens.is_empty() {
        return 0;
    }
    lens.sort_unstable();
    let m = lens.len() / 2;
    if lens.len() % 2 == 1 {
        lens[m]
    } else {
        (lens[m - 1] + lens[m]) / 2
    }
}

/// Merge `reads` into requests with the median read length as the
/// largest gap. Every read is a member of exactly one request.
pub fn merge(reads: &[Range<u64>], max_request: u64, max_overfetch: u64) -> Vec<Merged> {
    let max_gap = median_len(reads);
    let mut order: Vec<usize> = (0..reads.len()).collect();
    // offset order, longest first among equal offsets
    order.sort_by(|&a, &b| {
        reads[a]
            .start
            .cmp(&reads[b].start)
            .then((reads[b].end - reads[b].start).cmp(&(reads[a].end - reads[a].start)))
    });
    let mut out: Vec<Merged> = Vec::new();
    for i in order {
        let r = &reads[i];
        if let Some(cur) = out.last_mut() {
            if r.start < cur.range.end {
                cur.range.end = cur.range.end.max(r.end);
                cur.members.push(i);
                continue;
            }
            let gap = r.start - cur.range.end;
            let len = r.end - cur.range.start;
            let overfetch = cur.overfetch + gap;
            if gap <= max_gap && len <= max_request && overfetch <= max_overfetch {
                cur.range.end = r.end;
                cur.overfetch = overfetch;
                cur.members.push(i);
                continue;
            }
        }
        out.push(Merged {
            range: r.clone(),
            members: vec![i],
            overfetch: 0,
        });
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adjacent_reads_merge_into_one() {
        let reads = vec![0..10, 10..20, 20..30];
        let m = merge(&reads, 1 << 20, 1 << 20);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].range, 0..30);
        assert_eq!(m[0].overfetch, 0);
        assert_eq!(m[0].members, vec![0, 1, 2]);
    }

    #[test]
    fn gap_beyond_median_splits() {
        // median length 10; a gap of 11 starts a new request
        let reads = vec![0..10, 21..31, 31..41];
        let m = merge(&reads, 1 << 20, 1 << 20);
        assert_eq!(m.len(), 2);
        assert_eq!(m[1].range, 21..41);
    }

    #[test]
    fn small_gap_is_overfetched() {
        let reads = vec![0..10, 15..25];
        let m = merge(&reads, 1 << 20, 1 << 20);
        assert_eq!(m.len(), 1);
        assert_eq!(m[0].overfetch, 5);
    }

    #[test]
    fn request_and_overfetch_caps() {
        let reads = vec![0..10, 10..20, 20..30];
        assert_eq!(merge(&reads, 20, 1 << 20).len(), 2);
        let reads = vec![0..10, 12..22, 24..34];
        assert_eq!(merge(&reads, 1 << 20, 3).len(), 2);
    }

    #[test]
    fn unordered_and_overlapping_reads_keep_their_index() {
        let reads = vec![20..30, 0..10, 5..15, 100..110];
        let m = merge(&reads, 1 << 20, 1 << 20);
        let mut all: Vec<usize> = m.iter().flat_map(|g| g.members.clone()).collect();
        all.sort_unstable();
        assert_eq!(all, vec![0, 1, 2, 3]);
        assert_eq!(m[0].range, 0..30);
        assert_eq!(m[1].range, 100..110);
    }

    #[test]
    fn empty_input() {
        assert!(merge(&[], 1 << 20, 1 << 20).is_empty());
    }
}
