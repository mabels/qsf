// Stage 3 of the read pipeline: bind StreamConfigRecords to their data stream.
//
// bindConfigsToStreams() → TransformStream<…, StreamFileBegin | StreamFileEnd | QRecEvt>
//
// StreamConfigRecord         → runs the detect() fold over opts.filters to resolve
//                              FilterEntry instances, then parks config in waiting map.
// STREAM_HEADER(streamId)    → matches waiting config → emits StreamFileBegin, pipe open.
// STREAM_DATA(streamId)      → evt.data piped into the StreamFileBegin writable.
//                              If the consumer cancelled stream, evt.data is drained to devNull.
// STREAM_TRAILER(streamId)   → writable closed, StreamFileBegin.stream completes.
// StreamResultRecord         → emitted as StreamFileEnd (already carries filterResult).
// Everything else             → passes through unchanged.
//
// Stream cancellation: calling stream.cancel() on a StreamFileBegin.stream removes the
// writable from the map so subsequent STREAM_DATA frames for that stream are silently
// discarded, letting the outer reader pipeline advance to a clean end.

import { type } from "arktype";
import { FrameType } from "../frame.js";
import { Varint } from "../varint.js";
import { isStreamConfigRecord, isStreamResultRecord, type StreamConfigRecord, type StreamResultRecord } from "../manifest-types.js";
import { isQRecEvt, type QRecEvt } from "./bytes-to-qrecevt.js";
import type { ManifestEvt } from "./parse-manifest-evt.js";
import { buildDecodeStream } from "./decode.js";
import type { FilterDecodeFactory, FilterEntry } from "../filters/types.js";

/**
 * Emitted by {@link QsfReader} when a new logical stream begins.
 *
 * - `stream` — raw encoded bytes as they arrive off the wire (post-framing,
 *   pre-filter). Suitable for pass-through or manual inspection.
 *   Call `stream.cancel()` to discard the stream and let the reader advance cleanly.
 * - `decode()` — returns a new `ReadableStream` that pipes `stream` through all
 *   resolved filter decoders (e.g. ZStr decompress → CID verify), yielding the
 *   original plaintext bytes.
 */
export type StreamFileBegin = StreamConfigRecord & {
  stream: ReadableStream<Uint8Array>;
  decode(): ReadableStream<Uint8Array>;
};

const StreamFileBeginMarker = type({ type: '"stream.config"', stream: "object" });

export function isStreamFileBegin(e: unknown): e is StreamFileBegin {
  return !(StreamFileBeginMarker(e) instanceof type.errors);
}

/**
 * Emitted by {@link QsfReader} when a logical stream completes.
 *
 * `filterResult` contains one entry per encoder in declaration order,
 * e.g. `[{ type: "CID.result", cid: "bafkrei…" }, { type: "ZStr.result", codec: "deflate" }]`.
 * Use {@link streamIdOf} to correlate with the preceding {@link StreamFileBegin}.
 */
export type StreamFileEnd = StreamResultRecord;

export function isStreamFileEnd(e: unknown): e is StreamFileEnd {
  return isStreamResultRecord(e);
}

export function bindConfigsToStreams(opts?: {
  decoders?: FilterDecodeFactory[];
  highWaterMark?: number;
}): TransformStream<QRecEvt | ManifestEvt, StreamFileBegin | StreamFileEnd | QRecEvt> {
  const resolvers: FilterDecodeFactory[] = opts?.decoders ?? [];
  const highWaterMark = opts?.highWaterMark ?? 16;

  const waiting = new Map<number, { config: StreamConfigRecord; entries: FilterEntry[] }>();
  const writables = new Map<number, WritableStream<Uint8Array>>();

  return new TransformStream({
    async transform(evt, ctrl): Promise<void> {
      if (isStreamConfigRecord(evt)) {
        // Build initial FilterEntry[] — no instances yet — then fold resolvers.
        let resolvedEntries: FilterEntry[] = evt.filters.map((input) => ({ input }));
        for (const resolver of resolvers) {
          resolvedEntries = await resolver.detect(evt, resolvedEntries);
        }
        waiting.set(Varint.fromObject(evt.streamId).value, { config: evt, entries: resolvedEntries });
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
          const pending = waiting.get(evt.header.streamId);
          if (!pending) {
            ctrl.enqueue(evt);
            return;
          }
          waiting.delete(evt.header.streamId);

          const { config, entries } = pending;
          const streamId = evt.header.streamId;

          // Custom readable/writable pair with backpressure:
          //   cancel()  on the readable removes the writable from the map so
          //             subsequent STREAM_DATA frames are drained to devNull.
          //   pull()    fires when the consumer reads and desiredSize goes
          //             positive — resolves the pending wait in write() so
          //             pipeTo() is unblocked only when the consumer is ready.
          let streamCtrl!: ReadableStreamDefaultController<Uint8Array>;
          let readyResolve: (() => void) | undefined;
          const readable = new ReadableStream<Uint8Array>(
            {
              start(c): void {
                streamCtrl = c;
              },
              pull(): void {
                readyResolve?.();
                readyResolve = undefined;
              },
              cancel(): void {
                readyResolve?.();
                readyResolve = undefined;
                writables.delete(streamId);
              },
            },
            new CountQueuingStrategy({ highWaterMark }),
          );
          const writable = new WritableStream<Uint8Array>({
            async write(chunk): Promise<void> {
              try {
                streamCtrl.enqueue(chunk);
                if ((streamCtrl.desiredSize ?? 1) <= 0) {
                  await new Promise<void>((resolve) => {
                    readyResolve = resolve;
                  });
                }
              } catch {
                /* readable already cancelled */
              }
            },
            close(): void {
              try {
                streamCtrl.close();
              } catch {
                /* readable already cancelled */
              }
            },
            abort(reason: unknown): void {
              try {
                streamCtrl.error(reason);
              } catch {
                /* readable already cancelled */
              }
            },
          });

          writables.set(streamId, writable);
          ctrl.enqueue({
            ...config,
            stream: readable,
            decode(): ReadableStream<Uint8Array> {
              return buildDecodeStream(readable, entries);
            },
          });
          return;
        }

        case FrameType.STREAM_DATA: {
          const writable = writables.get(evt.header.streamId);
          if (writable) {
            await evt.data.pipeTo(writable, { preventClose: true });
          } else {
            // Stream was cancelled — drain frame data so no reader lock lingers.
            const r = evt.data.getReader();
            while (!(await r.read()).done) {
              /* devNull */
            }
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
