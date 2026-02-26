import type { FilterConfig, StreamConfigRecord } from "../manifest-types.js";

/** Binds a manifest filter config to its resolved decode instance. */
export interface FilterEntry {
  input: FilterConfig;
  instance?: FilterDecode;
}

/**
 * Write-side filter: participates in the encoder pipeline for a single stream.
 *
 * - `config()` — returns the manifest entry written before the stream data.
 * - `encode()` — returns a `TransformStream` that transforms bytes on the way out.
 * - `result()` — returns a summary written into `StreamFileEnd.filterResult` after flush.
 */
export interface FilterEncode {
  config(): Promise<FilterConfig>;
  encode(): TransformStream<Uint8Array, Uint8Array>;
  result(): Promise<{ type: string } | undefined>;
}

/**
 * Read-side filter: decodes bytes for a single stream.
 *
 * - `decode()` — returns a `TransformStream` that inverts what `FilterEncode.encode()` did.
 */
export interface FilterDecode {
  decode(): TransformStream<Uint8Array, Uint8Array>;
}

/**
 * Factory that inspects a `StreamConfigRecord` and stamps the appropriate
 * {@link FilterDecode} instance onto matching {@link FilterEntry} slots.
 *
 * Passed to {@link QsfReader} via `opts.decoders`. The built-in factories for
 * CID and ZStr are always prepended automatically.
 */
export interface FilterDecodeFactory {
  detect(rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]>;
}
