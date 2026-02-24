// Decode pipeline builder — applies filter configs in reverse order.
//
// Since EncryptFilter is now per-chunk streaming, key resolution happens
// lazily on the first chunk via KeyStoreEncryptFilter (no buffering needed).

import type { StreamConfigRecord } from "../manifest-types.js";
import type { Filter } from "../filters/types.js";
import { CIDFilter } from "../filters/cid.js";
import { ZStrFilter, type ZStrCodec } from "../filters/zstr.js";

export type KeyStore = (keyId: string) => Promise<CryptoKey | undefined>;

export function buildDecodeStream(
  source: ReadableStream<Uint8Array>,
  filterConfigs: StreamConfigRecord["filters"],
  keyStore: KeyStore,
): ReadableStream<Uint8Array> {
  const filters: Filter[] = [];
  for (const fc of [...filterConfigs].reverse()) {
    switch (fc.type) {
      case "CID":
        filters.push(new CIDFilter({ combineId: fc.combineId }));
        break;
      case "ZStr":
        filters.push(new ZStrFilter(fc.codec as ZStrCodec));
        break;
      case "Encrypt":
        filters.push(new KeyStoreEncryptFilter(fc.keyId, keyStore));
        break;
    }
  }
  let result = source;
  for (const f of filters) result = result.pipeThrough(f.decode());
  return result;
}

// Resolves the key from KeyStore on the first chunk, then decrypts each chunk
// independently — streaming, no buffering.
class KeyStoreEncryptFilter implements Filter {
  readonly #keyId: string;
  readonly #keyStore: KeyStore;

  constructor(keyId: string, keyStore: KeyStore) {
    this.#keyId = keyId;
    this.#keyStore = keyStore;
  }

  config(): { type: "Encrypt"; algo: "aes-gcm"; keyId: string } {
    return { type: "Encrypt" as const, algo: "aes-gcm" as const, keyId: this.#keyId };
  }

  result(): undefined {
    return undefined;
  }

  encode(): TransformStream<Uint8Array, Uint8Array> {
    throw new Error("KeyStoreEncryptFilter is decode-only");
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    const keyId = this.#keyId;
    const keyStore = this.#keyStore;
    let key: CryptoKey | undefined;

    return new TransformStream({
      async transform(chunk, ctrl): Promise<void> {
        if (!key) {
          const resolved = await keyStore(keyId);
          if (!resolved) {
            ctrl.error(new Error(`No key found for keyId: ${keyId}`));
            return;
          }
          key = resolved;
        }
        const iv = chunk.slice(0, 12);
        const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, chunk.slice(12));
        ctrl.enqueue(new Uint8Array(pt));
      },
    });
  }
}
