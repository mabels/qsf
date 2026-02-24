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
  type: '"CID"',
  "combineId?": "string",
});
export type FilterConfigCID = typeof FilterConfigCID.infer;

export const FilterConfigZStr = type({
  type: '"ZStr"',
  codec: '"deflate" | "deflate-raw" | "gzip"',
});
export type FilterConfigZStr = typeof FilterConfigZStr.infer;

// IV is embedded in the ciphertext (first 12 bytes), so it is NOT stored here.
// keyId is a short hex fingerprint — used by the reader to locate the right key.
export const FilterConfigEncrypt = type({
  type: '"Encrypt"',
  algo: '"aes-gcm"',
  keyId: "string",
});
export type FilterConfigEncrypt = typeof FilterConfigEncrypt.infer;

export const FilterConfig = FilterConfigCID.or(FilterConfigZStr).or(FilterConfigEncrypt);
export type FilterConfig = typeof FilterConfig.infer;

// ── Filter result ─────────────────────────────────────────────────────────────

export const FilterResult = type({
  filterName: "string",
  result: "unknown",
});
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
  cid: "string", // CID computed over pre-transform (original) bytes
  offset: "number", // byte offset of first STREAM_DATA frame in the file
  length: "number", // total payload bytes across all STREAM_DATA frames
  filterResult: FilterResult.array(), // per-filter summaries; filters returning undefined are skipped
});
export type StreamResultRecord = typeof StreamResultRecord.infer;

export const ManifestRecord = StreamConfigRecord.or(StreamResultRecord);
export type ManifestRecord = typeof ManifestRecord.infer;

// ── Guards ────────────────────────────────────────────────────────────────────

export function isStreamConfigRecord(x: unknown): x is StreamConfigRecord {
  return !(StreamConfigRecord(x) instanceof type.errors);
}

export function isStreamResultRecord(x: unknown): x is StreamResultRecord {
  return !(StreamResultRecord(x) instanceof type.errors);
}

export function isManifestRecord(x: unknown): x is ManifestRecord {
  return !(ManifestRecord(x) instanceof type.errors);
}
