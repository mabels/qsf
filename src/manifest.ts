// ManifestStream — encodes ManifestRecords as JSON and wraps them in
// MANIFEST_ENTRY frames for interleaved writing into the qsf file.
//
// JSON is used deliberately: manifest entries are human-readable metadata
// (filter configs, CIDs, offsets) and must never contain binary payloads.
//
// emit() is async — the caller must await it so manifest frames are flushed
// before the writer closes the sink.
//
// The numeric streamId is passed separately so the frame header carries it
// directly — the reader can group manifest frames by streamId without parsing
// the JSON payload.

import { encodeFrame, FrameType } from "./frame.js";
import type { ManifestRecord } from "./manifest-types.js";
import { defaultEnde, type QsfEnde } from "./ende.js";

export class ManifestStream {
  readonly #ende: QsfEnde;
  readonly #onFrame: (frame: Uint8Array) => Promise<void>;

  constructor(onFrame: (frame: Uint8Array) => Promise<void>, opts?: { ende?: QsfEnde }) {
    this.#ende = opts?.ende ?? defaultEnde;
    this.#onFrame = onFrame;
  }

  async emit(record: ManifestRecord, streamId: number): Promise<void> {
    const payload = this.#ende.encode(record);
    const frame = encodeFrame({ type: FrameType.MANIFEST_ENTRY, streamId, payload });
    await this.#onFrame(frame);
  }
}
