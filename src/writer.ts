// QsfWriter — pipes a list of { stream, filters } entries into a sink,
// interleaving QUIC-framed STREAM_DATA with JSON manifest entries.
//
// Each logical stream is assigned a monotonically increasing integer streamId.
// The streamId appears as a VarintObject in manifest records AND as a raw varint
// in every frame header — the reader matches them via Varint.fromObject(streamId).
//
// For each stream entry:
//   1. Assign streamId (incrementing counter).
//   2. Initialise encode() transforms (sets any per-encode state, e.g. IVs).
//   3. Emit StreamConfigRecord into the manifest (streamId + filter configs).
//   4. Write STREAM_HEADER frame.
//   5. Pipe stream through filter chain → write STREAM_DATA frames.
//   6. Await the CIDFilter promise (resolved at pipeline flush).
//   7. Write STREAM_TRAILER frame (cid).
//   8. Emit StreamResultRecord into the manifest (streamId + cid + byte range).

import { Varint } from "./varint.js";
import { encodeFrame, FrameType } from "./frame.js";
import { ManifestStream } from "./manifest.js";
import type { Filter } from "./filters/types.js";
import { CIDFilter } from "./filters/cid.js";
import { defaultEnde, type QsfEnde } from "./ende.js";

export interface StreamEntry {
  stream: ReadableStream<Uint8Array>;
  filters: Filter[];
  combineId?: string;
}

export interface WriteResult {
  streamId: number;
  cid: string;
  offset: number;
  length: number;
}

export class QsfWriter {
  readonly #ende: QsfEnde;
  #nextStreamId = 0;

  constructor(opts?: { ende?: QsfEnde }) {
    this.#ende = opts?.ende ?? defaultEnde;
  }

  async write(entries: StreamEntry[], sink: WritableStream<Uint8Array>): Promise<WriteResult[]> {
    const sinkWriter = sink.getWriter();
    let offset = 0;
    const results: WriteResult[] = [];

    const flush = async (bytes: Uint8Array): Promise<void> => {
      await sinkWriter.write(bytes);
      offset += bytes.byteLength;
    };

    const manifest = new ManifestStream(flush, { ende: this.#ende });

    for (const entry of entries) {
      const streamId = this.#nextStreamId++;
      const streamIdObj = new Varint(streamId).toObject();

      // 1. Initialise encode transforms first — stateful filters (e.g. EncryptFilter)
      //    generate per-stream state inside encode(), so config() must follow.
      const transforms = entry.filters.map((f) => f.encode());

      // 2. Emit StreamConfigRecord — configs are now fully initialised.
      const cidFilter = entry.filters.find((f): f is CIDFilter => f instanceof CIDFilter);
      await manifest.emit(
        {
          type: "stream.config",
          streamId: streamIdObj,
          ...(entry.combineId ? { combineId: entry.combineId } : {}),
          filters: entry.filters.map((f) => f.config()),
        },
        streamId,
      );

      // 3. STREAM_HEADER frame.
      await flush(encodeFrame({ type: FrameType.STREAM_HEADER, streamId, payload: new Uint8Array(0) }));

      // 4. Pipe stream through filter chain, emit STREAM_DATA frames.
      const dataOffset = offset;
      let dataLength = 0;

      let readable: ReadableStream<Uint8Array> = entry.stream;
      for (const transform of transforms) {
        readable = readable.pipeThrough(transform);
      }

      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await flush(encodeFrame({ type: FrameType.STREAM_DATA, streamId, payload: value }));
        dataLength += value.byteLength;
      }

      // 5. Await CID — resolved during pipeline flush before reader returns done.
      const cid = cidFilter ? await cidFilter.cidPromise : "";

      // 6. STREAM_TRAILER frame.
      await flush(
        encodeFrame({
          type: FrameType.STREAM_TRAILER,
          streamId,
          payload: this.#ende.encode({ cid }),
        }),
      );

      // 7. Emit StreamResultRecord.
      const filterResult = entry.filters
        .map((f) => ({ filterName: f.config().type, result: f.result() }))
        .filter((r) => r.result !== undefined);

      await manifest.emit(
        {
          type: "stream.result",
          streamId: streamIdObj,
          cid,
          offset: dataOffset,
          length: dataLength,
          filterResult,
        },
        streamId,
      );

      results.push({ streamId, cid, offset: dataOffset, length: dataLength });
    }

    await sinkWriter.close();
    return results;
  }
}
