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
import type { FilterEncode } from "./filters/types.js";
import { defaultEnde, type QsfEnde } from "./ende.js";

/** A single logical stream to be written into the QSF container. */
export interface WriterStreamEntry {
  /** The raw source bytes. */
  stream: ReadableStream<Uint8Array>;
  /** Ordered list of encoders applied left-to-right (e.g. `[new CIDEncode(), new ZStrEncode()]`). */
  encoders: FilterEncode[];
  /**
   * Optional group tag. Entries sharing the same `combineId` are treated as
   * members of one logical record (e.g. data + metadata for the same document).
   * Used by {@link CIDCollector} to derive a combined file name.
   */
  combineId?: string;
}

/** Per-stream result returned by {@link QsfWriter.write}. */
export interface WriteResult {
  /** Zero-based index assigned to this stream within the container. */
  streamId: number;
  /** Byte offset of this stream's data within the container. */
  offset: number;
  /** Byte length of the encoded (post-filter) stream data. */
  length: number;
  /** Results reported by each encoder, e.g. `[{ type: "CID.result", cid: "bafkrei…" }]`. */
  filterResult: { type: string }[];
}

export class QsfWriter {
  readonly #ende: QsfEnde;
  #nextStreamId = 0;

  constructor(opts?: { ende?: QsfEnde }) {
    this.#ende = opts?.ende ?? defaultEnde;
  }

  /**
   * Writes one or more streams into a single multiplexed QSF container.
   *
   * Each entry passes its data through the declared filter pipeline
   * (e.g. CIDEncode → ZStrEncode) before being framed and written to the sink.
   *
   * @param entries One or more streams with their encoder pipelines. Each entry
   *   may carry a `combineId` to group related streams (e.g. data + metadata).
   * @param sink The writable destination that receives the encoded QSF bytes.
   * @returns One {@link WriteResult} per entry, containing the streamId,
   *   byte offset/length in the container, and any filter results (e.g. CID).
   */
  async write(entries: WriterStreamEntry[], sink: WritableStream<Uint8Array>): Promise<WriteResult[]> {
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
      const transforms = entry.encoders.map((f) => f.encode());

      // 2. Emit StreamConfigRecord — configs are now fully initialised.
      await manifest.emit(
        {
          type: "stream.config",
          streamId: streamIdObj,
          ...(entry.combineId ? { combineId: entry.combineId } : {}),
          filters: await Promise.all(entry.encoders.map((f) => f.config())),
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
      // const cid = cidFilter ? await cidFilter.cidPromise : "";

      const filterResult: { type: string }[] = (await Promise.all(entry.encoders.map((f) => f.result()))).filter(
        (r): r is { type: string } => r !== undefined,
      );
      // 6. STREAM_TRAILER frame.
      await flush(
        encodeFrame({
          type: FrameType.STREAM_TRAILER,
          streamId,
          payload: this.#ende.encode({}),
        }),
        // await Promise.all(
        // entry.filters.map((f) => f.result()).filter((r) => r !== undefined))),
        // }),
      );

      // 7. Emit StreamResultRecord.

      await manifest.emit(
        {
          type: "stream.result",
          // cid,
          streamId: streamIdObj,
          offset: dataOffset,
          length: dataLength,
          filterResult,
        },
        streamId,
      );

      results.push({ streamId, offset: dataOffset, length: dataLength, filterResult });
    }

    await sinkWriter.close();
    return results;
  }
}
