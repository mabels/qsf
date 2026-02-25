// Arktype schemas for manifest records stored in MANIFEST_ENTRY frames.
//
// Two record types per logical stream:
//
//   StreamConfigRecord  — written at stream *creation* time (before data flows).
//                         Contains filter pipeline config (codecs, key fingerprints).
//
//   StreamResultRecord  — written at stream *completion* time.
//                         Contains the CID and byte range for seeking.
//
// Records are linked to data frames by `streamId` — a VarintObject (e.g.
// { f: "1B", v: "0x3" }) that mirrors the varint stream_id in every frame header.

import { type } from "arktype";
import { VarintType } from "./varint.js";

// ── Filter config schemas ─────────────────────────────────────────────────────

export const FilterConfigCID = type({
  type: '"CID.config"',
  "combineId?": "string",
});
export type FilterConfigCID = typeof FilterConfigCID.infer;

export const FilterConfigZStr = type({
  type: '"ZStr.config"',
  codec: '"deflate" | "deflate-raw" | "gzip"',
});
export type FilterConfigZStr = typeof FilterConfigZStr.infer;

// Open catch-all: any filter implementation may define its own config shape.
// The manifest only requires a string `type` discriminant; the rest is up to the filter.
const FilterConfigOpen = type({ type: "string", "+": "ignore" });

export const FilterConfig = FilterConfigCID.or(FilterConfigZStr).or(FilterConfigOpen);
export type FilterConfig = typeof FilterConfig.infer;

// ── Filter result schemas ─────────────────────────────────────────────────────

export const FilterResultCID = type({
  type: '"CID.result"',
  cid: "string",
});
export type FilterResultCID = typeof FilterResultCID.infer;

export const FilterResultZStr = type({
  type: '"ZStr.result"',
  codec: '"deflate" | "deflate-raw" | "gzip"',
});
export type FilterResultZStr = typeof FilterResultZStr.infer;

// Open catch-all: custom filters define their own result shape.
const FilterResultOpen = type({ type: "string", "+": "ignore" });

export const FilterResult = FilterResultCID.or(FilterResultZStr).or(FilterResultOpen);
export type FilterResult = typeof FilterResult.infer;

// ── Manifest record schemas ───────────────────────────────────────────────────

export const StreamConfigRecord = type({
  type: '"stream.config"',
  streamId: VarintType, // mirrors frame header stream_id
  "combineId?": "string", // optional group label (e.g. "rec-1" for data+meta pair)
  filters: FilterConfig.array(),
});
export type StreamConfigRecord = typeof StreamConfigRecord.infer;

export const StreamResultRecord = type({
  type: '"stream.result"',
  streamId: VarintType, // matches StreamConfigRecord.streamId
  // cid: "string", // CID computed over pre-transform (original) bytes
  offset: "number", // byte offset of first STREAM_DATA frame in the file
  length: "number", // total payload bytes across all STREAM_DATA frames
  filterResult: FilterResult.array(), // per-filter summaries; filters returning undefined are skipped
});
export type StreamResultRecord = typeof StreamResultRecord.infer;

export const ManifestRecord = StreamConfigRecord.or(StreamResultRecord);
export type ManifestRecord = typeof ManifestRecord.infer;

// ── Guards ────────────────────────────────────────────────────────────────────

export function isFilterConfigCID(x: unknown): x is FilterConfigCID {
  return !(FilterConfigCID(x) instanceof type.errors);
}

export function isFilterConfigZStr(x: unknown): x is FilterConfigZStr {
  return !(FilterConfigZStr(x) instanceof type.errors);
}

export function isFilterResultCID(x: unknown): x is FilterResultCID {
  return !(FilterResultCID(x) instanceof type.errors);
}

export function isFilterResultZStr(x: unknown): x is FilterResultZStr {
  return !(FilterResultZStr(x) instanceof type.errors);
}

export function isStreamConfigRecord(x: unknown): x is StreamConfigRecord {
  return !(StreamConfigRecord(x) instanceof type.errors);
}

export function isStreamResultRecord(x: unknown): x is StreamResultRecord {
  return !(StreamResultRecord(x) instanceof type.errors);
}

export function isManifestRecord(x: unknown): x is ManifestRecord {
  return !(ManifestRecord(x) instanceof type.errors);
}
