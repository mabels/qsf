// EncryptFilter — AES-GCM per-chunk streaming encryption.
//
// Each incoming chunk is independently encrypted with a fresh random IV.
// Output layout per chunk: [iv: 12 bytes][ciphertext + 16-byte auth tag]
//
// This allows true streaming decryption — each chunk can be decrypted
// independently as it arrives, with no need to buffer the full stream.
//
// keyId (short hex fingerprint) is stored in the manifest so the reader can
// locate the correct CryptoKey from a key store without storing the key itself.
// Build keyId with the exported keyFingerprint() helper below.

import { sha256 } from "@noble/hashes/sha2";
import type { FilterConfigEncrypt } from "../manifest-types.js";
import type { Filter } from "./types.js";

export class EncryptFilter implements Filter {
  readonly #key: CryptoKey;
  readonly #keyId: string;

  constructor(key: CryptoKey, keyId: string) {
    this.#key = key;
    this.#keyId = keyId;
  }

  config(): FilterConfigEncrypt {
    return { type: "Encrypt", algo: "aes-gcm", keyId: this.#keyId };
  }

  result(): unknown {
    return { keyId: this.#keyId };
  }

  encode(): TransformStream<Uint8Array, Uint8Array> {
    const key = this.#key;
    return new TransformStream({
      async transform(chunk, ctrl): Promise<void> {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, chunk.buffer as ArrayBuffer);
        const out = new Uint8Array(12 + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), 12);
        ctrl.enqueue(out);
      },
    });
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    const key = this.#key;
    return new TransformStream({
      async transform(chunk, ctrl): Promise<void> {
        const iv = chunk.slice(0, 12);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, chunk.slice(12));
        ctrl.enqueue(new Uint8Array(pt));
      },
    });
  }
}

// Derive a short hex fingerprint from a CryptoKey.
// Exports raw key material, SHA2-256 hashes it, returns first 8 bytes as hex.
export async function keyFingerprint(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  const hash = sha256(new Uint8Array(raw));
  return Array.from(hash.slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
