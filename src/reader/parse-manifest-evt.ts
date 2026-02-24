// Stage 2 of the read pipeline: parse MANIFEST_ENTRY frames into typed records.
//
// parseManifestEvt(opts?) → TransformStream<QRecEvt, QRecEvt | ManifestEvt>
//
// MANIFEST_ENTRY frames whose JSON payload matches a known manifest record
// are replaced with the parsed record. Everything else passes through unchanged.

import { type } from "arktype";
import { stream2uint8array } from "@adviser/cement";
import { FrameType } from "../frame.js";
import { isStreamConfigRecord, isStreamResultRecord, type StreamConfigRecord, type StreamResultRecord } from "../manifest-types.js";
import { isQRecEvt, type QRecEvt } from "./bytes-to-qrecevt.js";
import { defaultEnde, type QsfEnde } from "../ende.js";

export type ManifestEvt = StreamConfigRecord | StreamResultRecord;

const ManifestEvtMarker = type({ type: '"stream.config" | "stream.result"' });

export function isManifestEvt(e: unknown): e is ManifestEvt {
  return !(ManifestEvtMarker(e) instanceof type.errors);
}

export function parseManifestEvt(opts?: { ende?: QsfEnde }): TransformStream<QRecEvt, QRecEvt | ManifestEvt> {
  const ende = opts?.ende ?? defaultEnde;
  return new TransformStream({
    async transform(evt, ctrl): Promise<void> {
      if (!isQRecEvt(evt) || evt.header.type !== FrameType.MANIFEST_ENTRY) {
        ctrl.enqueue(evt);
        return;
      }

      const buf = await stream2uint8array(evt.data);
      let record: unknown;
      try {
        record = ende.decode<unknown>(buf);
      } catch {
        ctrl.enqueue(evt);
        return;
      }

      if (isStreamConfigRecord(record) || isStreamResultRecord(record)) {
        ctrl.enqueue(record);
      } else {
        ctrl.enqueue(evt); // unknown manifest record — pass through
      }
    },
  });
}
