// CIDFilter — pass-through that accumulates a SHA2-256 CID over bytes seen
// during encode(). CID is over the *original* bytes (before ZStr/Encrypt),
// so it identifies content regardless of storage encoding.
//
// cidPromise resolves at encode flush. The writer awaits it before emitting
// the StreamResultRecord into the manifest.
//
// decode() recomputes and verifies the CID against the stored value.

import { sha256 } from "@noble/hashes/sha2";
import { CID } from "multiformats";
import { create as createDigest } from "multiformats/hashes/digest";
import * as raw from "multiformats/codecs/raw";
import type { FilterConfigCID } from "../manifest-types.js";
import type { Filter } from "./types.js";

const SHA2_256 = 0x12;

export class CIDFilter implements Filter {
  readonly #combineId?: string;
  #encodedCid?: string;

  readonly cidPromise: Promise<string>;
  readonly #resolve: (cid: string) => void;
  readonly #reject: (err: unknown) => void;

  constructor(opts?: { combineId?: string }) {
    this.#combineId = opts?.combineId;
    let res!: (cid: string) => void;
    let rej!: (err: unknown) => void;
    this.cidPromise = new Promise((r, e) => {
      res = r;
      rej = e;
    });
    this.#resolve = res;
    this.#reject = rej;
  }

  config(): FilterConfigCID {
    return {
      type: "CID",
      ...(this.#combineId ? { combineId: this.#combineId } : {}),
    };
  }

  encode(): TransformStream<Uint8Array, Uint8Array> {
    const h = sha256.create();
    const resolve = this.#resolve;
    const reject = this.#reject;
    const storeCid = (cid: string): void => {
      this.#encodedCid = cid;
    };
    return new TransformStream({
      transform(chunk, ctrl): void {
        h.update(chunk);
        ctrl.enqueue(chunk);
      },
      flush(): void {
        try {
          const digest = createDigest(SHA2_256, h.digest());
          const cid = CID.create(1, raw.code, digest).toString();
          storeCid(cid);
          resolve(cid);
        } catch (e) {
          reject(e);
        }
      },
    });
  }

  result(): unknown {
    return { cid: this.#encodedCid ?? "" };
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    const expected = this.#encodedCid;
    const h = sha256.create();
    return new TransformStream({
      transform(chunk, ctrl): void {
        h.update(chunk);
        ctrl.enqueue(chunk);
      },
      flush(ctrl): void {
        const digest = createDigest(SHA2_256, h.digest());
        const computed = CID.create(1, raw.code, digest).toString();
        if (expected && computed !== expected) {
          ctrl.error(new Error(`CID mismatch: expected ${expected}, got ${computed}`));
        }
      },
    });
  }
}
