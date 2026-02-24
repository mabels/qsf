// QUIC-inspired on-disk frame format
//
// Each frame:
//   [type: varint][stream_id: varint][payload_length: varint][payload: bytes]
//
// stream_id links data frames to their manifest records. The writer assigns
// a monotonically increasing integer per logical stream. Both the data frames
// and the manifest records (StreamConfigRecord / StreamResultRecord) carry the
// same stream_id so the reader can join them without parsing JSON payloads.
//
// Frame types:
//   0x01  STREAM_HEADER   — marks start of a logical stream
//   0x02  STREAM_DATA     — chunk of (transformed) stream bytes
//   0x03  STREAM_TRAILER  — CID computed over pre-transform bytes
//   0x04  MANIFEST_ENTRY  — StreamConfigRecord or StreamResultRecord (JSON)
//   0x05  INDEX           — list of manifest-entry byte offsets (fast seek)
//   0x06  FOOTER          — 8-byte offset pointing to the INDEX frame

import { Varint } from "./varint.js";

export const FrameType = {
  STREAM_HEADER: 0x01,
  STREAM_DATA: 0x02,
  STREAM_TRAILER: 0x03,
  MANIFEST_ENTRY: 0x04,
  INDEX: 0x05,
  FOOTER: 0x06,
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
  readonly type: FrameTypeValue;
  readonly streamId: number;
  readonly payload: Uint8Array;
}

// ── Encode ────────────────────────────────────────────────────────────────────

export function encodeFrame(frame: Frame): Uint8Array {
  const typeBytes = new Varint(frame.type).toBytes();
  const sidBytes = new Varint(frame.streamId).toBytes();
  const lenBytes = new Varint(frame.payload.byteLength).toBytes();
  const out = new Uint8Array(typeBytes.byteLength + sidBytes.byteLength + lenBytes.byteLength + frame.payload.byteLength);
  let o = 0;
  out.set(typeBytes, o);
  o += typeBytes.byteLength;
  out.set(sidBytes, o);
  o += sidBytes.byteLength;
  out.set(lenBytes, o);
  o += lenBytes.byteLength;
  out.set(frame.payload, o);
  return out;
}

// ── Decode ────────────────────────────────────────────────────────────────────

export interface DecodeFrameResult {
  readonly frame: Frame;
  readonly bytesConsumed: number;
}

export function decodeFrame(buf: Uint8Array, offset = 0): DecodeFrameResult {
  let o = offset;
  const { varint: type, bytesRead: tr } = Varint.fromBytes(buf, o);
  o += tr;
  const { varint: streamId, bytesRead: sr } = Varint.fromBytes(buf, o);
  o += sr;
  const { varint: length, bytesRead: lr } = Varint.fromBytes(buf, o);
  o += lr;
  const payload = buf.slice(o, o + length.value);
  return {
    frame: { type: type.value as FrameTypeValue, streamId: streamId.value, payload },
    bytesConsumed: tr + sr + lr + length.value,
  };
}

export function* iterFrames(buf: Uint8Array): Generator<{ frame: Frame; offset: number }> {
  let offset = 0;
  while (offset < buf.byteLength) {
    const { frame, bytesConsumed } = decodeFrame(buf, offset);
    yield { frame, offset };
    offset += bytesConsumed;
  }
}
