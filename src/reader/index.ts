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

export function streamIdOf(evt: QsfStreamEvt): number {
  return Varint.fromObject(evt.streamId).value;
}

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
