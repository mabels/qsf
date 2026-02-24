import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, iterFrames, FrameType } from "./frame.js";

const payload = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("frame", () => {
  describe("encodeFrame / decodeFrame roundtrip", () => {
    it("STREAM_HEADER with empty payload", () => {
      const frame = { type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) };
      const { frame: out, bytesConsumed } = decodeFrame(encodeFrame(frame));
      expect(out.type).toBe(FrameType.STREAM_HEADER);
      expect(out.streamId).toBe(0);
      expect(out.payload.byteLength).toBe(0);
      expect(bytesConsumed).toBe(3); // 1B type + 1B streamId + 1B length
    });

    it("STREAM_DATA with payload", () => {
      const frame = { type: FrameType.STREAM_DATA, streamId: 3, payload: payload("hello world") };
      const { frame: out } = decodeFrame(encodeFrame(frame));
      expect(out.type).toBe(FrameType.STREAM_DATA);
      expect(out.streamId).toBe(3);
      expect(new TextDecoder().decode(out.payload)).toBe("hello world");
    });

    it("MANIFEST_ENTRY with JSON payload", () => {
      const json = JSON.stringify({ type: "stream.config", streamId: { f: "1B", v: "0x1" } });
      const frame = { type: FrameType.MANIFEST_ENTRY, streamId: 0, payload: payload(json) };
      const { frame: out } = decodeFrame(encodeFrame(frame));
      expect(out.type).toBe(FrameType.MANIFEST_ENTRY);
      expect(JSON.parse(new TextDecoder().decode(out.payload))).toMatchObject({ type: "stream.config" });
    });

    it("STREAM_TRAILER", () => {
      const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
      const frame = { type: FrameType.STREAM_TRAILER, streamId: 7, payload: payload(JSON.stringify({ cid })) };
      const { frame: out } = decodeFrame(encodeFrame(frame));
      expect(out.streamId).toBe(7);
      expect((JSON.parse(new TextDecoder().decode(out.payload)) as { cid: string }).cid).toBe(cid);
    });

    it("preserves large streamId (4B range)", () => {
      const frame = { type: FrameType.STREAM_DATA, streamId: 20_000, payload: payload("x") };
      const { frame: out } = decodeFrame(encodeFrame(frame));
      expect(out.streamId).toBe(20_000);
    });
  });

  describe("iterFrames", () => {
    it("iterates multiple frames in sequence", () => {
      const a = encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) });
      const b = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload: payload("chunk") });
      const c = encodeFrame({ type: FrameType.STREAM_TRAILER, streamId: 0, payload: payload("{}") });
      const buf = new Uint8Array([...a, ...b, ...c]);

      const frames = [...iterFrames(buf)].map(({ frame }) => frame);
      expect(frames).toHaveLength(3);
      expect(frames[0].type).toBe(FrameType.STREAM_HEADER);
      expect(frames[1].type).toBe(FrameType.STREAM_DATA);
      expect(frames[2].type).toBe(FrameType.STREAM_TRAILER);
    });

    it("reports correct byte offsets", () => {
      const a = encodeFrame({ type: FrameType.STREAM_HEADER, streamId: 0, payload: new Uint8Array(0) });
      const b = encodeFrame({ type: FrameType.STREAM_DATA, streamId: 0, payload: payload("hello") });
      const buf = new Uint8Array([...a, ...b]);

      const entries = [...iterFrames(buf)];
      expect(entries[0].offset).toBe(0);
      expect(entries[1].offset).toBe(a.byteLength);
    });

    it("returns nothing for empty buffer", () => {
      expect([...iterFrames(new Uint8Array(0))]).toHaveLength(0);
    });
  });
});
