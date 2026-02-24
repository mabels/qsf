// Stage 1 of the read pipeline: raw bytes → parsed QRecEvt objects.
//
// bytesToQRecEvt(input) → ReadableStream<QRecEvt>
//
// Each emitted QRecEvt has:
//   header — the three varint fields decoded to plain numbers
//   data   — a ReadableStream bounded to exactly header.length bytes
//
// Uses Varint.fromBytes() for all varint decoding.
// ByteReader handles reassembly of partial input chunks.

import { type } from "arktype";
import { Varint } from "../varint.js";
import { FrameType, type FrameTypeValue } from "../frame.js";

export interface QRecEvtHeader {
  type: FrameTypeValue;
  streamId: number;
  length: number;
}

const QRecEvtMarker = type({ type: '"qrec.frame"' });

export interface QRecEvt {
  type: "qrec.frame";
  header: QRecEvtHeader;
  data: ReadableStream<Uint8Array>; // exactly header.length bytes
}

export function isQRecEvt(e: unknown): e is QRecEvt {
  return !(QRecEvtMarker(e) instanceof type.errors);
}

export function bytesToQRecEvt(input: ReadableStream<Uint8Array>): ReadableStream<QRecEvt> {
  const br = new ByteReader(input);

  return new ReadableStream<QRecEvt>({
    async pull(ctrl): Promise<void> {
      const typeV = await br.readVarint();
      if (!typeV) {
        ctrl.close();
        return;
      }

      const streamIdV = await br.readVarint();
      if (!streamIdV) throw new Error("qrec: truncated frame (missing streamId)");
      const lengthV = await br.readVarint();
      if (!lengthV) throw new Error("qrec: truncated frame (missing length)");

      const length = lengthV.value;
      const payload = length > 0 ? await br.readBytes(length) : new Uint8Array(0);
      if (!payload) throw new Error("qrec: truncated frame (missing payload)");

      ctrl.enqueue({
        type: "qrec.frame",
        header: {
          type: typeV.value as FrameTypeValue,
          streamId: streamIdV.value,
          length,
        },
        data: new ReadableStream({
          start(c): void {
            c.enqueue(payload);
            c.close();
          },
        }),
      });
    },
  });
}

// ── ByteReader ─────────────────────────────────────────────────────────────────
// Pulls exact byte counts from a ReadableStream, reassembling partial chunks.

class ByteReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #pending = new Uint8Array(0);

  constructor(stream: ReadableStream<Uint8Array>) {
    this.#reader = stream.getReader();
  }

  // Read a QUIC varint using Varint.fromBytes(). Returns null on clean EOF.
  async readVarint(): Promise<Varint | null> {
    const first = await this.readBytes(1);
    if (!first) return null; // clean EOF

    const prefix = (first[0] & 0xc0) >> 6;
    const width = [1, 2, 4, 8][prefix];

    if (width === 1) return Varint.fromBytes(first).varint;

    const rest = await this.readBytes(width - 1);
    if (!rest) throw new Error("qrec: truncated varint");

    const buf = new Uint8Array(width);
    buf.set(first, 0);
    buf.set(rest, 1);
    return Varint.fromBytes(buf).varint;
  }

  // Read exactly n bytes. Returns null only at a clean EOF (zero buffered bytes).
  async readBytes(n: number): Promise<Uint8Array | null> {
    if (n === 0) return new Uint8Array(0);

    while (this.#pending.byteLength < n) {
      const { done, value } = await this.#reader.read();
      if (done) {
        if (this.#pending.byteLength === 0) return null;
        throw new Error("qrec: unexpected end of stream");
      }
      const merged = new Uint8Array(this.#pending.byteLength + value.byteLength);
      merged.set(this.#pending, 0);
      merged.set(value, this.#pending.byteLength);
      this.#pending = merged;
    }

    const result = this.#pending.slice(0, n);
    this.#pending = this.#pending.slice(n);
    return result;
  }
}

// re-export FrameType so consumers can reference it without importing frame.ts
export { FrameType };
