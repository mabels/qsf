// Encryption building blocks for qsf.
//
// Architecture:
//   EnDecrypt       — chunk-level encrypt/decrypt contract
//   AESGCMEnDecrypt — AES-GCM-256 implementation; IV prepended per chunk
//   EnDecryptEncode — abstract FilterEncode: encode delegated to EnDecrypt.encrypt
//   EnDecryptDecode — concrete FilterDecode: decode delegated to EnDecrypt.decrypt
//
// Per-chunk wire format: [iv: 12 bytes][ciphertext + 16-byte GCM auth tag]
//
// For production use, extend EnDecryptEncode and supply your own key
// management in config() / result().
// For tests, use TestEncryptEncode / TestEncryptDecodeFactory from ./test-encrypt.js.

import { sha256 } from "@noble/hashes/sha2.js";
import type { FilterConfig } from "../manifest-types.js";
import type { FilterEncode, FilterDecode } from "./types.js";

// ── EnDecrypt interface ───────────────────────────────────────────────────────

export interface EnDecrypt {
  encrypt(chunk: Uint8Array): Promise<Uint8Array>;
  decrypt(chunk: Uint8Array): Promise<Uint8Array>;
}

// ── AESGCMEnDecrypt ───────────────────────────────────────────────────────────

export class AESGCMEnDecrypt implements EnDecrypt {
  readonly #key?: CryptoKey;

  static async create(key: CryptoKey): Promise<AESGCMEnDecrypt> {
    return new AESGCMEnDecrypt(key);
  }

  constructor(key?: CryptoKey) {
    this.#key = key;
  }

  fingerPrint(): Promise<string> {
    if (!this.#key) return Promise.reject(new Error("AESGCMEnDecrypt: no key — provide a CryptoKey to the constructor"));
    return crypto.subtle.exportKey("raw", this.#key).then((raw) => {
      const hash = sha256(new Uint8Array(raw));
      return Array.from(hash)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    });
  }

  async encrypt(chunk: Uint8Array): Promise<Uint8Array> {
    if (!this.#key) throw new Error("AESGCMEnDecrypt: no key — provide a CryptoKey to the constructor");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.#key, chunk.buffer as ArrayBuffer);
    const out = new Uint8Array(12 + ct.byteLength);
    out.set(iv, 0);
    out.set(new Uint8Array(ct), 12);
    return out;
  }

  async decrypt(chunk: Uint8Array): Promise<Uint8Array> {
    if (!this.#key) throw new Error("AESGCMEnDecrypt: no key — provide a CryptoKey to the constructor");
    const iv = chunk.slice(0, 12);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, this.#key, chunk.slice(12));
    return new Uint8Array(pt);
  }
}

// ── EnDecryptEncode ───────────────────────────────────────────────────────────

// Abstract base for the write side: wires EnDecrypt.encrypt into the FilterEncode
// stream interface. Subclasses supply the manifest concerns: config(), result().
export abstract class EnDecryptEncode implements FilterEncode {
  readonly #enDecrypt: EnDecrypt;

  constructor(enDecrypt: EnDecrypt) {
    this.#enDecrypt = enDecrypt;
  }

  abstract config(): Promise<FilterConfig>;
  abstract result(): Promise<{ type: string } | undefined>;

  encode(): TransformStream<Uint8Array, Uint8Array> {
    const enDecrypt = this.#enDecrypt;
    return new TransformStream({
      async transform(chunk, ctrl): Promise<void> {
        ctrl.enqueue(await enDecrypt.encrypt(chunk));
      },
    });
  }
}

// ── EnDecryptDecode ───────────────────────────────────────────────────────────

// Concrete read-side class: wires EnDecrypt.decrypt into the FilterDecode
// stream interface. Instantiated by FilterDecodeFactory implementations.
export class EnDecryptDecode implements FilterDecode {
  readonly #enDecrypt: EnDecrypt;

  constructor(enDecrypt: EnDecrypt) {
    this.#enDecrypt = enDecrypt;
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    const enDecrypt = this.#enDecrypt;
    return new TransformStream({
      async transform(chunk, ctrl): Promise<void> {
        ctrl.enqueue(await enDecrypt.decrypt(chunk));
      },
    });
  }
}
