import { describe, it, expect } from "vitest";
import { CIDFilter } from "./cid.js";

async function pipe(source: Uint8Array[], transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array[]> {
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
  return chunks;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

describe("CIDFilter", () => {
  it("passes bytes through unchanged", async () => {
    const input = [new TextEncoder().encode("hello"), new TextEncoder().encode(" world")];
    const f = new CIDFilter();
    const out = concat(await pipe(input, f.encode()));
    expect(new TextDecoder().decode(out)).toBe("hello world");
  });

  it("resolves cidPromise after encode flush", async () => {
    const f = new CIDFilter();
    await pipe([new TextEncoder().encode("hello world")], f.encode());
    const cid = await f.cidPromise;
    expect(cid).toMatch(/^bafkrei/); // CIDv1 raw codec = bafkrei prefix
  });

  it("produces same CID for same content regardless of chunking", async () => {
    const content = new TextEncoder().encode("deterministic content");

    const f1 = new CIDFilter();
    await pipe([content], f1.encode());

    const f2 = new CIDFilter();
    await pipe([content.slice(0, 8), content.slice(8)], f2.encode());

    expect(await f1.cidPromise).toBe(await f2.cidPromise);
  });

  it("decode() passes bytes through and verifies CID", async () => {
    const input = [new TextEncoder().encode("verify me")];
    const f = new CIDFilter();

    // encode to learn the CID
    const encoded = await pipe(input, f.encode());
    await f.cidPromise;

    // decode should pass through without error
    const decoded = concat(await pipe(encoded, f.decode()));
    expect(new TextDecoder().decode(decoded)).toBe("verify me");
  });

  it("decode() errors on tampered bytes", async () => {
    const input = [new TextEncoder().encode("original")];
    const f = new CIDFilter();
    await pipe(input, f.encode());
    await f.cidPromise;

    // pipe different bytes through decode
    await expect(pipe([new TextEncoder().encode("tampered")], f.decode())).rejects.toThrow("CID mismatch");
  });

  it("supports optional combineId in config", () => {
    const f = new CIDFilter({ combineId: "rec-1" });
    expect(f.config()).toEqual({ type: "CID", combineId: "rec-1" });
  });

  it("omits combineId from config when not set", () => {
    expect(new CIDFilter().config()).toEqual({ type: "CID" });
  });
});
