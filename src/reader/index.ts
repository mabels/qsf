// QsfReader — composes the three pipeline stages into a single readable stream.
//
//   bytesToQRecEvt        → raw bytes into typed frames
//   parseManifestEvt      → MANIFEST_ENTRY frames decoded to StreamConfigRecord / StreamResultRecord
//   bindConfigsToStreams  → config + STREAM_HEADER matched into StreamFileBegin
//   filter                → leftover QRecEvt frames dropped
//
// Output: ReadableStream<QsfStreamEvt>
//   StreamFileBegin  — stream.config record + live ReadableStream + decode(keyStore)
//   StreamFileEnd    — stream.result record (cid, offset, length, filterResult)
//
// Both carry streamId: VarintObject — use streamIdOf() to correlate them.

import { bytesToQRecEvt } from "./bytes-to-qrecevt.js";
import { parseManifestEvt } from "./parse-manifest-evt.js";
import { bindConfigsToStreams, isStreamFileBegin, isStreamFileEnd } from "./config-with-stream.js";
import { Varint } from "../varint.js";
import type { QsfEnde } from "../ende.js";

export { isStreamFileBegin } from "./config-with-stream.js";
export type { StreamFileBegin } from "./config-with-stream.js";
export { isStreamFileEnd } from "./config-with-stream.js";
export type { StreamFileEnd } from "./config-with-stream.js";
export type { KeyStore } from "./decode.js";

export type QsfStreamEvt = import("./config-with-stream.js").StreamFileBegin | import("./config-with-stream.js").StreamFileEnd;

export function streamIdOf(evt: QsfStreamEvt): number {
  return Varint.fromObject(evt.streamId).value;
}

export function QsfReader(input: ReadableStream<Uint8Array>, opts?: { ende?: QsfEnde }): ReadableStream<QsfStreamEvt> {
  return (
    bytesToQRecEvt(input)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      .pipeThrough(parseManifestEvt(opts) as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument
      .pipeThrough(bindConfigsToStreams() as any)
      .pipeThrough(
        new TransformStream({
          transform(evt, ctrl): void {
            if (isStreamFileBegin(evt) || isStreamFileEnd(evt)) ctrl.enqueue(evt);
            // drop leftover QRecEvt frames
          },
        }),
      )
  );
}
