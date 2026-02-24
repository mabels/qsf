import { describe, it, expect } from "vitest";
import { bytesToQRecEvt, type QRecEvt } from "./bytes-to-qrecevt.js";
import { encodeFrame, FrameType } from "../frame.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function collectEvts(stream: ReadableStream<QRecEvt>): Promise<QRecEvt[]> {
  const reader = stream.getReader();
  const evts: QRecEvt[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    evts.push(value);
  }
  return evts;
}

async function collectBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

function concat(...bufs: Uint8Array[]): Uint8Array {
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of bufs) {
    out.set(b, o);
    o += b.byteLength;
  }
  return out;
}

// Wrap a buffer as a ReadableStream, optionally splitting into fixed-size chunks.
function toStream(buf: Uint8Array, chunkSize = buf.byteLength): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(ctrl): void {
      for (let i = 0; i < buf.byteLength; i += chunkSize) {
        ctrl.enqueue(buf.slice(i, i + chunkSize));
      }
      ctrl.close();
    },
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("bytesToQRecEvt", () => {
  it("empty stream produces no events", async () => {
    const evts = await collectEvts(bytesToQRecEvt(toStream(new Uint8Array(0))));
    expect(evts).toHaveLength(0);
  });

  it("decodes a single STREAM_DATA frame — header fields and payload", async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload });

    const evts = await collectEvts(bytesToQRecEvt(toStream(buf)));

    expect(evts).toHaveLength(1);
    expect(evts[0].header.type).toBe(FrameType.STREAM_DATA);
    expect(evts[0].header.streamId).toBe(0);
    expect(evts[0].header.length).toBe(5);
    expect(await collectBytes(evts[0].data)).toEqual(payload);
  });

  it("decodes an empty-payload frame (STREAM_HEADER)", async () => {
    const buf = encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 2, payload: new Uint8Array(0) });

    const evts = await collectEvts(bytesToQRecEvt(toStream(buf)));

    expect(evts).toHaveLength(1);
    expect(evts[0].header.type).toBe(FrameType.STREAM_HEADER);
    expect(evts[0].header.streamId).toBe(2);
    expect(evts[0].header.length).toBe(0);
    expect(await collectBytes(evts[0].data)).toEqual(new Uint8Array(0));
  });

  it("decodes multiple frames in emission order", async () => {
    const buf = concat(
      encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) }),
      encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload: new Uint8Array([10, 20, 30]) }),
      encodeFrame({ type: FrameType.MANIFEST_ENTRY, streamId: 0, payload: new Uint8Array([99]) }),
      encodeFrame({ type: FrameType.STREAM_TRAILER, streamId: 0, payload: new Uint8Array([42]) }),
    );

    const evts = await collectEvts(bytesToQRecEvt(toStream(buf)));

    expect(evts).toHaveLength(4);
    expect(evts[0].header.type).toBe(FrameType.STREAM_HEADER);
    expect(evts[1].header.type).toBe(FrameType.STREAM_DATA);
    expect(evts[2].header.type).toBe(FrameType.MANIFEST_ENTRY);
    expect(evts[3].header.type).toBe(FrameType.STREAM_TRAILER);

    expect(await collectBytes(evts[1].data)).toEqual(new Uint8Array([10, 20, 30]));
  });

  describe("varint widths for streamId", () => {
    it("1B varint  (streamId = 0)", async () => {
      const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload: new Uint8Array([1]) });
      const [evt] = await collectEvts(bytesToQRecEvt(toStream(buf)));
      expect(evt.header.streamId).toBe(0);
    });

    it("1B varint  (streamId = 63, max 1B)", async () => {
      const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 63, payload: new Uint8Array([1]) });
      const [evt] = await collectEvts(bytesToQRecEvt(toStream(buf)));
      expect(evt.header.streamId).toBe(63);
    });

    it("2B varint  (streamId = 64, first 2B value)", async () => {
      const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 64, payload: new Uint8Array([1]) });
      const [evt] = await collectEvts(bytesToQRecEvt(toStream(buf)));
      expect(evt.header.streamId).toBe(64);
    });

    it("4B varint  (streamId = 16_384, first 4B value)", async () => {
      const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 16_384, payload: new Uint8Array([1]) });
      const [evt] = await collectEvts(bytesToQRecEvt(toStream(buf)));
      expect(evt.header.streamId).toBe(16_384);
    });
  });

  describe("partial chunk delivery", () => {
    it("byte-by-byte: reassembles a single frame correctly", async () => {
      const payload = new Uint8Array([7, 8, 9]);
      const buf = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 1, payload });

      const evts = await collectEvts(bytesToQRecEvt(toStream(buf, 1)));

      expect(evts).toHaveLength(1);
      expect(evts[0].header.streamId).toBe(1);
      expect(await collectBytes(evts[0].data)).toEqual(payload);
    });

    it("split mid-header: second frame's header split across two input chunks", async () => {
      const f1 = encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) });
      const f2 = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 1, payload: new Uint8Array([55]) });
      const combined = concat(f1, f2);

      // Deliver f1 complete + first byte of f2's header in chunk 1;
      // remainder of f2 in chunk 2 — varint split across the boundary.
      const splitAt = f1.byteLength + 1;
      const evts = await collectEvts(
        bytesToQRecEvt(
          new ReadableStream({
            start(ctrl): void {
              ctrl.enqueue(combined.slice(0, splitAt));
              ctrl.enqueue(combined.slice(splitAt));
              ctrl.close();
            },
          }),
        ),
      );

      expect(evts).toHaveLength(2);
      expect(evts[0].header.type).toBe(FrameType.STREAM_HEADER);
      expect(evts[1].header.type).toBe(FrameType.STREAM_DATA);
      expect(evts[1].header.streamId).toBe(1);
      expect(await collectBytes(evts[1].data)).toEqual(new Uint8Array([55]));
    });

    it("byte-by-byte: multiple frames all decoded correctly", async () => {
      const buf = concat(
        encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) }),
        encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload: new Uint8Array([1, 2]) }),
        encodeFrame({ type: FrameType.STREAM_TRAILER, streamId: 0, payload: new Uint8Array([3]) }),
      );

      const evts = await collectEvts(bytesToQRecEvt(toStream(buf, 1)));

      expect(evts).toHaveLength(3);
      expect(evts[1].header.streamId).toBe(0);
      expect(await collectBytes(evts[1].data)).toEqual(new Uint8Array([1, 2]));
    });
  });
});
