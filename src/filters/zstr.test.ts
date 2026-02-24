// NOTE: CompressionStream / DecompressionStream require:
//   - Chrome >= 80, Firefox >= 113, Safari >= 16.4
//   - Node.js >= 18
// These tests will be skipped in environments that lack the API.

import { describe, it, expect } from "vitest";
import { ZStrFilter, type ZStrCodec } from "./zstr.js";

async function pipe(source: Uint8Array[], transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const reader = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      for (const chunk of source) ctrl.enqueue(chunk);
      ctrl.close();
    },
  })
    .pipeThrough(transform)
    .getReader();

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

const hasCompressionStream = typeof CompressionStream !== "undefined";
const maybeIt = hasCompressionStream ? it : it.skip;

const codecs: ZStrCodec[] = ["deflate", "deflate-raw", "gzip"];

describe("ZStrFilter", () => {
  for (const codec of codecs) {
    describe(`codec: ${codec}`, () => {
      maybeIt("roundtrips short text", async () => {
        const input = new TextEncoder().encode("hello compression world");
        const f = new ZStrFilter(codec);
        const compressed = await pipe([input], f.encode());
        const decompressed = await pipe([compressed], f.decode());
        expect(new TextDecoder().decode(decompressed)).toBe("hello compression world");
      });

      maybeIt("roundtrips larger repeated content", async () => {
        const input = new TextEncoder().encode("abcdef".repeat(1000));
        const f = new ZStrFilter(codec);
        const compressed = await pipe([input], f.encode());
        const decompressed = await pipe([compressed], f.decode());
        expect(decompressed).toEqual(input);
        // compression should actually reduce size for repetitive content
        expect(compressed.byteLength).toBeLessThan(input.byteLength);
      });

      maybeIt("roundtrips multi-chunk input", async () => {
        const text = "chunk ".repeat(500);
        const enc = new TextEncoder().encode(text);
        const mid = Math.floor(enc.byteLength / 2);
        const f = new ZStrFilter(codec);
        const compressed = await pipe([enc.slice(0, mid), enc.slice(mid)], f.encode());
        const decompressed = await pipe([compressed], f.decode());
        expect(new TextDecoder().decode(decompressed)).toBe(text);
      });

      it("config reports correct codec", () => {
        expect(new ZStrFilter(codec).config()).toEqual({ type: "ZStr", codec });
      });
    });
  }

  it("defaults to deflate", () => {
    expect(new ZStrFilter().config().codec).toBe("deflate");
  });
});
