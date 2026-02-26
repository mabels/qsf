// QsfReader — composes the three pipeline stages into a single readable stream.
//
//   bytesToQRecEvt        → raw bytes into typed frames
//   parseManifestEvt      → MANIFEST_ENTRY frames decoded to StreamConfigRecord / StreamResultRecord
//   bindConfigsToStreams  → config + STREAM_HEADER matched into StreamFileBegin
//   filter                → leftover QRecEvt frames dropped
//
// Output: ReadableStream<QsfStreamEvt>
//   StreamFileBegin  — stream.config record + live ReadableStream + decode()
//   StreamFileEnd    — stream.result record (cid, offset, length, filterResult)
//
// Both carry streamId: VarintObject — use streamIdOf() to correlate them.
//
// opts.decoders — additional FilterDecodeFactory[] appended after the built-in
// [CIDFilter, ZStrFilter] defaults. Use it to supply e.g. TestEncryptFilter
// for encrypted streams.

import { bytesToQRecEvt, QRecEvt } from "./bytes-to-qrecevt.js";
import { ManifestEvt, parseManifestEvt } from "./parse-manifest-evt.js";
import { bindConfigsToStreams, isStreamFileBegin, isStreamFileEnd, StreamFileBegin, StreamFileEnd } from "./config-with-stream.js";
import { Varint } from "../varint.js";
import type { FilterDecodeFactory } from "../filters/types.js";
import type { QsfEnde } from "../ende.js";
import { CIDDecodeFactory } from "../filters/cid.js";
import { ZStrDecodeFactory } from "../filters/zstr.js";

export { isStreamFileBegin } from "./config-with-stream.js";
export type { StreamFileBegin } from "./config-with-stream.js";
export { isStreamFileEnd } from "./config-with-stream.js";
export type { StreamFileEnd } from "./config-with-stream.js";
export type { FilterEntry } from "../filters/types.js";

export type QsfStreamEvt = StreamFileBegin | StreamFileEnd;

/**
 * Returns the numeric stream ID shared by a {@link StreamFileBegin} and its
 * corresponding {@link StreamFileEnd}, allowing them to be correlated when
 * reading a multi-stream container.
 *
 * @param evt A `StreamFileBegin` or `StreamFileEnd` event from {@link QsfReader}.
 * @returns The numeric stream ID.
 */
export function streamIdOf(evt: QsfStreamEvt): number {
  return Varint.fromObject(evt.streamId).value;
}

/**
 * Reads a QSF container and emits a {@link QsfStreamEvt} per logical stream.
 *
 * The pipeline automatically applies the built-in CID and ZStr decoders.
 * Additional decoders (e.g. for encryption) can be supplied via `opts.decoders`.
 *
 * Each {@link StreamFileBegin} carries a live `stream` and a `decode()` method
 * that returns the fully decoded (decompressed / decrypted) bytes.
 * Each {@link StreamFileEnd} carries the `filterResult` array (e.g. CID hash)
 * for the completed stream.
 *
 * Use {@link streamIdOf} to correlate a `StreamFileBegin` with its `StreamFileEnd`.
 *
 * @param input A readable byte stream containing QSF-encoded data.
 * @param opts.decoders Additional {@link FilterDecodeFactory} instances appended
 *   after the built-in CID and ZStr decoders (e.g. `[new MyEncryptDecodeFactory()]`).
 * @param opts.highWaterMark Internal read-ahead buffer size per stream, defaults to 16.
 * @returns A `ReadableStream<QsfStreamEvt>` that emits `StreamFileBegin` and
 *   `StreamFileEnd` events, one pair per logical stream in the container.
 */
export function QsfReader(
  input: ReadableStream<Uint8Array>,
  opts?: { ende?: QsfEnde; decoders?: FilterDecodeFactory[]; highWaterMark?: number },
): ReadableStream<QsfStreamEvt> {
  const decoders: FilterDecodeFactory[] = [new CIDDecodeFactory(), new ZStrDecodeFactory(), ...(opts?.decoders ?? [])];
  return bytesToQRecEvt(input)
    .pipeThrough<QRecEvt | ManifestEvt>(parseManifestEvt(opts))
    .pipeThrough<StreamFileBegin | StreamFileEnd | QRecEvt>(bindConfigsToStreams({ ...opts, decoders }))
    .pipeThrough(
      new TransformStream<StreamFileBegin | StreamFileEnd | QRecEvt, QsfStreamEvt>({
        transform(evt, ctrl): void {
          if (isStreamFileBegin(evt) || isStreamFileEnd(evt)) ctrl.enqueue(evt);
          // drop leftover QRecEvt frames
        },
      }),
    );
}
