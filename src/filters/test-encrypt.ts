// TestEncrypt filter — test-only concrete split into two classes.
//
// TestEncryptEncode (FilterEncode via EnDecryptEncode):
//   Generates an AES-GCM key and serialises the raw bytes (base64) into
//   config() so the reader can reconstruct the key directly from the manifest.
//   NOT safe for production (key material lives in the manifest).
//
// TestEncryptDecodeFactory (FilterDecodeFactory):
//   No key needed. detect() reads the serialized key from each TestEncrypt
//   entry in the StreamConfigRecord, imports it, and stamps a live
//   EnDecryptDecode instance.
//
// Usage:
//   const tf = await TestEncryptEncode.create();
//   const buf = await writeToBuf([{ stream, encoders: [tf] }]);
//   QsfReader(stream, { decoders: [new TestEncryptDecodeFactory()] })

import { AESGCMEnDecrypt, EnDecryptEncode, EnDecryptDecode } from "./encrypt.js";
import type { StreamConfigRecord } from "../manifest-types.js";
import type { FilterDecodeFactory, FilterEntry } from "./types.js";

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function isTestEncryptConfig(x: unknown): x is { type: "TestEncrypt.config"; key: string } {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return r["type"] === "TestEncrypt.config" && typeof r["key"] === "string";
}

// ── TestEncryptEncode ─────────────────────────────────────────────────────────

export class TestEncryptEncode extends EnDecryptEncode {
  readonly #serializedKey: string;

  constructor(aesGcm: AESGCMEnDecrypt, serializedKey: string) {
    super(aesGcm);
    this.#serializedKey = serializedKey;
  }

  async config(): Promise<{ type: "TestEncrypt.config"; key: string }> {
    return { type: "TestEncrypt.config", key: this.#serializedKey };
  }

  async result(): Promise<{ type: "TestEncrypt.result" }> {
    return { type: "TestEncrypt.result" };
  }

  static async create(): Promise<TestEncryptEncode> {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const raw = await crypto.subtle.exportKey("raw", key);
    return new TestEncryptEncode(new AESGCMEnDecrypt(key), toBase64(new Uint8Array(raw)));
  }
}

// ── TestEncryptDecodeFactory ──────────────────────────────────────────────────

export class TestEncryptDecodeFactory implements FilterDecodeFactory {
  async detect(_rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
    return Promise.all(
      filters.map(async (e) => {
        if (e.instance || !isTestEncryptConfig(e.input)) return e;
        const key = await crypto.subtle.importKey(
          "raw",
          fromBase64(e.input.key).buffer as ArrayBuffer,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"],
        );
        return { ...e, instance: new EnDecryptDecode(new AESGCMEnDecrypt(key)) };
      }),
    );
  }
}
