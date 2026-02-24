import { describe, it, expect } from "vitest";
import { EncryptFilter, keyFingerprint } from "./encrypt.js";

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// Pipe chunks through a transform, collect and concatenate all output chunks.
async function pipe(source: Uint8Array[], transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array> {
  const chunks = await pipeChunks(source, transform);
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

// Pipe chunks through a transform, return output as an array (one entry per emitted chunk).
async function pipeChunks(source: Uint8Array[], transform: TransformStream<Uint8Array, Uint8Array>): Promise<Uint8Array[]> {
  const reader = new ReadableStream<Uint8Array>({
    start(ctrl): void {
      for (const chunk of source) ctrl.enqueue(chunk);
      ctrl.close();
    },
  })
    .pipeThrough(transform)
    .getReader();

  const out: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

describe("EncryptFilter", () => {
  it("roundtrips a single chunk", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const input = new TextEncoder().encode("secret message");

    const f = new EncryptFilter(key, keyId);
    const encrypted = await pipe([input], f.encode());
    const decrypted = await pipe([encrypted], f.decode());
    expect(new TextDecoder().decode(decrypted)).toBe("secret message");
  });

  it("ciphertext differs from plaintext", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const input = new TextEncoder().encode("hello");

    const f = new EncryptFilter(key, keyId);
    const encrypted = await pipe([input], f.encode());
    expect(encrypted).not.toEqual(input);
  });

  it("each chunk carries its own IV + GCM tag overhead (12 + 16 bytes)", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const input = new TextEncoder().encode("hello world");

    const f = new EncryptFilter(key, keyId);
    const [encChunk] = await pipeChunks([input], f.encode());
    expect(encChunk.byteLength).toBe(input.byteLength + 12 + 16);
  });

  it("each input chunk produces exactly one encrypted output chunk", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])];

    const f = new EncryptFilter(key, keyId);
    const encChunks = await pipeChunks(parts, f.encode());

    expect(encChunks).toHaveLength(3);
    expect(encChunks[0].byteLength).toBe(2 + 12 + 16);
    expect(encChunks[1].byteLength).toBe(2 + 12 + 16);
    expect(encChunks[2].byteLength).toBe(1 + 12 + 16);
  });

  it("each encode() call produces a different ciphertext (fresh IV per chunk)", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const input = new TextEncoder().encode("same content");

    const f = new EncryptFilter(key, keyId);
    const enc1 = await pipe([input], f.encode());
    const enc2 = await pipe([input], f.encode());
    expect(enc1).not.toEqual(enc2);
  });

  it("roundtrips multi-chunk input — each chunk independently encrypted/decrypted", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const text = "x".repeat(10_000);
    const enc = new TextEncoder().encode(text);
    const mid = Math.floor(enc.byteLength / 3);
    const parts = [enc.slice(0, mid), enc.slice(mid, mid * 2), enc.slice(mid * 2)];

    const f = new EncryptFilter(key, keyId);
    // encode produces one encrypted chunk per input chunk
    const encChunks = await pipeChunks(parts, f.encode());
    expect(encChunks).toHaveLength(3);

    // decode receives each encrypted chunk independently
    const decrypted = await pipe(encChunks, f.decode());
    expect(new TextDecoder().decode(decrypted)).toBe(text);
  });

  it("wrong key fails to decrypt", async () => {
    const key1 = await generateKey();
    const key2 = await generateKey();
    const keyId = await keyFingerprint(key1);
    const input = new TextEncoder().encode("top secret");

    const enc = await pipe([input], new EncryptFilter(key1, keyId).encode());
    await expect(pipe([enc], new EncryptFilter(key2, keyId).decode())).rejects.toThrow();
  });

  describe("keyFingerprint", () => {
    it("returns a 16-char hex string", async () => {
      const key = await generateKey();
      expect(await keyFingerprint(key)).toMatch(/^[0-9a-f]{16}$/);
    });

    it("is deterministic for the same key", async () => {
      const key = await generateKey();
      expect(await keyFingerprint(key)).toBe(await keyFingerprint(key));
    });

    it("differs for different keys", async () => {
      const k1 = await generateKey();
      const k2 = await generateKey();
      expect(await keyFingerprint(k1)).not.toBe(await keyFingerprint(k2));
    });
  });

  describe("config", () => {
    it("returns algo and keyId", async () => {
      const key = await generateKey();
      const keyId = await keyFingerprint(key);
      expect(new EncryptFilter(key, keyId).config()).toEqual({ type: "Encrypt", algo: "aes-gcm", keyId });
    });
  });
});
