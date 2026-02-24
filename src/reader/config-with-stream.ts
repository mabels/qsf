// Stage 3 of the read pipeline: bind StreamConfigRecords to their data stream.
//
// bindConfigsToStreams() → TransformStream<…, StreamFileBegin | StreamFileEnd | QRecEvt>
//
// StreamConfigRecord         → parked in waiting map (keyed by streamId), not emitted.
// STREAM_HEADER(streamId)    → matches waiting config → emits StreamFileBegin, pipe open.
// STREAM_DATA(streamId)      → evt.data piped into the StreamFileBegin writable.
// STREAM_TRAILER(streamId)   → writable closed, StreamFileBegin.stream completes.
// StreamResultRecord         → emitted as StreamFileEnd (already carries filterResult).
// Everything else             → passes through unchanged.

import { type } from "arktype";
import { FrameType } from "../frame.js";
import { Varint } from "../varint.js";
import { isStreamConfigRecord, isStreamResultRecord, type StreamConfigRecord, type StreamResultRecord } from "../manifest-types.js";
import { isQRecEvt, type QRecEvt } from "./bytes-to-qrecevt.js";
import type { ManifestEvt } from "./parse-manifest-evt.js";
import { buildDecodeStream, type KeyStore } from "./decode.js";

export type StreamFileBegin = StreamConfigRecord & {
  stream: ReadableStream<Uint8Array>;
  decode(keyStore: KeyStore): ReadableStream<Uint8Array>;
};

const StreamFileBeginMarker = type({ type: '"stream.config"', stream: "object" });

export function isStreamFileBegin(e: unknown): e is StreamFileBegin {
  return !(StreamFileBeginMarker(e) instanceof type.errors);
}

export type StreamFileEnd = StreamResultRecord;

export function isStreamFileEnd(e: unknown): e is StreamFileEnd {
  return isStreamResultRecord(e);
}

export function bindConfigsToStreams(): TransformStream<QRecEvt | ManifestEvt, StreamFileBegin | StreamFileEnd | QRecEvt> {
  const waiting = new Map<number, StreamConfigRecord>();
  const writables = new Map<number, WritableStream<Uint8Array>>();

  return new TransformStream({
    async transform(evt, ctrl): Promise<void> {
      if (isStreamConfigRecord(evt)) {
        waiting.set(Varint.fromObject(evt.streamId).value, evt);
        return;
      }

      if (isStreamResultRecord(evt)) {
        ctrl.enqueue(evt);
        return;
      }

      if (!isQRecEvt(evt)) {
        ctrl.enqueue(evt as QRecEvt);
        return;
      }

      switch (evt.header.type) {
        case FrameType.STREAM_HEADER: {
          const config = waiting.get(evt.header.streamId);
          if (!config) {
            ctrl.enqueue(evt);
            return;
          }
          waiting.delete(evt.header.streamId);

          const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>(
            {},
            new CountQueuingStrategy({ highWaterMark: Infinity }),
            new CountQueuingStrategy({ highWaterMark: Infinity }),
          );
          writables.set(evt.header.streamId, writable);
          ctrl.enqueue({
            ...config,
            stream: readable,
            decode: (keyStore: KeyStore) => buildDecodeStream(readable, config.filters, keyStore),
          });
          return;
        }

        case FrameType.STREAM_DATA: {
          const writable = writables.get(evt.header.streamId);
          if (writable) {
            await evt.data.pipeTo(writable, { preventClose: true });
          }
          return;
        }

        case FrameType.STREAM_TRAILER: {
          const writable = writables.get(evt.header.streamId);
          if (writable) {
            await writable.getWriter().close();
          }
          writables.delete(evt.header.streamId);
          return;
        }

        default:
          ctrl.enqueue(evt);
      }
    },
  });
}
