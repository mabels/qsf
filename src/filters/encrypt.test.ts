import { describe, it, expect } from "vitest";
import { AESGCMEnDecrypt } from "./encrypt.js";
import { TestEncryptEncode, TestEncryptDecodeFactory } from "./test-encrypt.js";

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

describe("AESGCMEnDecrypt", () => {
  it("roundtrips a single chunk", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const aes = new AESGCMEnDecrypt(key);
    const input = new TextEncoder().encode("secret message");
    const encrypted = await aes.encrypt(input);
    const decrypted = await aes.decrypt(encrypted);
    expect(new TextDecoder().decode(decrypted)).toBe("secret message");
  });

  it("ciphertext differs from plaintext", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const aes = new AESGCMEnDecrypt(key);
    const input = new TextEncoder().encode("hello");
    expect(await aes.encrypt(input)).not.toEqual(input);
  });

  it("each chunk carries its own IV + GCM tag overhead (12 + 16 bytes)", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const aes = new AESGCMEnDecrypt(key);
    const input = new TextEncoder().encode("hello world");
    const enc = await aes.encrypt(input);
    expect(enc.byteLength).toBe(input.byteLength + 12 + 16);
  });

  it("each encrypt() call produces a different ciphertext (fresh IV)", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const aes = new AESGCMEnDecrypt(key);
    const input = new TextEncoder().encode("same content");
    expect(await aes.encrypt(input)).not.toEqual(await aes.encrypt(input));
  });

  it("wrong key fails to decrypt", async () => {
    const k1 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const k2 = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const enc = await (await AESGCMEnDecrypt.create(k1)).encrypt(new TextEncoder().encode("top secret"));
    await expect((await AESGCMEnDecrypt.create(k2)).decrypt(enc)).rejects.toThrow();
  });
});

describe("TestEncryptEncode + TestEncryptDecodeFactory", () => {
  it("roundtrips a single chunk via encode/decode streams", async () => {
    const tf = await TestEncryptEncode.create();
    const cfg = await tf.config();
    const input = new TextEncoder().encode("secret message");
    const encrypted = await pipe([input], tf.encode());
    const [entry] = await new TestEncryptDecodeFactory().detect({} as never, [{ input: cfg }]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const decrypted = await pipe([encrypted], entry.instance!.decode());
    expect(new TextDecoder().decode(decrypted)).toBe("secret message");
  });

  it("each input chunk produces exactly one encrypted output chunk", async () => {
    const tf = await TestEncryptEncode.create();
    const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4]), new Uint8Array([5])];
    const encChunks = await pipeChunks(parts, tf.encode());
    expect(encChunks).toHaveLength(3);
    expect(encChunks[0].byteLength).toBe(2 + 12 + 16);
    expect(encChunks[1].byteLength).toBe(2 + 12 + 16);
    expect(encChunks[2].byteLength).toBe(1 + 12 + 16);
  });

  it("config() returns type TestEncrypt.config with serialized key", async () => {
    const tf = await TestEncryptEncode.create();
    const cfg = await tf.config();
    expect(cfg.type).toBe("TestEncrypt.config");
    expect(typeof cfg.key).toBe("string");
    // base64 of a 256-bit key = 32 bytes → 44 base64 chars (with padding)
    expect(cfg.key.length).toBe(44);
  });

  it("config() key round-trips — detect() from config decrypts what create() encoded", async () => {
    const tf = await TestEncryptEncode.create();
    const cfg = await tf.config();
    const input = new TextEncoder().encode("round trip");
    const enc = await pipe([input], tf.encode());
    // Reconstruct via detect() — same path as QsfReader
    const [resolved] = await new TestEncryptDecodeFactory().detect({} as never, [{ input: cfg }]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const decrypted = await pipe([enc], resolved.instance!.decode());
    expect(new TextDecoder().decode(decrypted)).toBe("round trip");
  });

  it("result() returns { type: 'TestEncrypt.result' }", async () => {
    const tf = await TestEncryptEncode.create();
    expect(await tf.result()).toEqual({ type: "TestEncrypt.result" });
  });

  it("detect() stamps a live instance from the manifest key", async () => {
    const tf = await TestEncryptEncode.create();
    const cfg = await tf.config();
    const entries = [{ input: cfg }];
    const resolved = await new TestEncryptDecodeFactory().detect({} as never, entries);
    expect(resolved[0].instance).toBeDefined();
  });

  it("wrong key fails to decrypt", async () => {
    const tf1 = await TestEncryptEncode.create();
    const tf2 = await TestEncryptEncode.create();
    const cfg2 = await tf2.config();
    const input = new TextEncoder().encode("top secret");
    const enc = await pipe([input], tf1.encode());
    const [entry] = await new TestEncryptDecodeFactory().detect({} as never, [{ input: cfg2 }]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    await expect(pipe([enc], entry.instance!.decode())).rejects.toThrow();
  });
});
