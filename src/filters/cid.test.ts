import { describe, it, expect } from "vitest";
import { CIDEncode, CIDDecode } from "./cid.js";

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

describe("CIDEncode", () => {
  it("passes bytes through unchanged", async () => {
    const input = [new TextEncoder().encode("hello"), new TextEncoder().encode(" world")];
    const f = new CIDEncode();
    const out = concat(await pipe(input, f.encode()));
    expect(new TextDecoder().decode(out)).toBe("hello world");
  });

  it("resolves cidPromise after encode flush", async () => {
    const f = new CIDEncode();
    await pipe([new TextEncoder().encode("hello world")], f.encode());
    const cid = await f.cidPromise;
    expect(cid).toMatch(/^bafkrei/); // CIDv1 raw codec = bafkrei prefix
  });

  it("produces same CID for same content regardless of chunking", async () => {
    const content = new TextEncoder().encode("deterministic content");

    const f1 = new CIDEncode();
    await pipe([content], f1.encode());

    const f2 = new CIDEncode();
    await pipe([content.slice(0, 8), content.slice(8)], f2.encode());

    expect(await f1.cidPromise).toBe(await f2.cidPromise);
  });

  it("supports optional combineId in config", async () => {
    const f = new CIDEncode({ combineId: "rec-1" });
    expect(await f.config()).toEqual({ type: "CID.config", combineId: "rec-1" });
  });

  it("omits combineId from config when not set", async () => {
    expect(await new CIDEncode().config()).toEqual({ type: "CID.config" });
  });
});

describe("CIDDecode", () => {
  it("passes bytes through unchanged", async () => {
    const input = [new TextEncoder().encode("verify me")];
    const dec = new CIDDecode();
    const decoded = concat(await pipe(input, dec.decode()));
    expect(new TextDecoder().decode(decoded)).toBe("verify me");
  });

  it("passes bytes through when expectedCid matches", async () => {
    const input = [new TextEncoder().encode("verify me")];
    const enc = new CIDEncode();
    const encoded = await pipe(input, enc.encode());
    const cid = await enc.cidPromise;

    const dec = new CIDDecode(cid);
    const decoded = concat(await pipe(encoded, dec.decode()));
    expect(new TextDecoder().decode(decoded)).toBe("verify me");
  });

  it("errors on tampered bytes when expectedCid is set", async () => {
    const enc = new CIDEncode();
    await pipe([new TextEncoder().encode("original")], enc.encode());
    const cid = await enc.cidPromise;

    const dec = new CIDDecode(cid);
    await expect(pipe([new TextEncoder().encode("tampered")], dec.decode())).rejects.toThrow("CID mismatch");
  });
});
