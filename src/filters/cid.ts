// CID filter — three classes for the three filter roles.
//
// CIDEncode   (FilterEncode)        — pass-through that accumulates a SHA2-256 CID
//                                     over bytes seen during encode(). cidPromise
//                                     resolves at encode flush.
// CIDDecode   (FilterDecode)        — pass-through that optionally verifies CID
//                                     against an expected value during decode().
// CIDDecodeFactory (FilterDecodeFactory) — detect() stamps CIDDecode on matching
//                                     entries so QsfReader can pipe through them.

import { sha256 } from "@noble/hashes/sha2.js";
import { CID } from "multiformats";
import { create as createDigest } from "multiformats/hashes/digest";
import * as raw from "multiformats/codecs/raw";
import { isFilterConfigCID, type FilterConfigCID, type StreamConfigRecord } from "../manifest-types.js";
import type { FilterEncode, FilterDecode, FilterDecodeFactory, FilterEntry } from "./types.js";

const SHA2_256 = 0x12;

// ── CIDEncode ─────────────────────────────────────────────────────────────────

/**
 * Pass-through encoder that computes a SHA2-256 CIDv1 over the bytes it sees.
 *
 * Add to a {@link WriterStreamEntry} encoders pipeline. After writing,
 * await `cidPromise` to retrieve the computed CID string (e.g. `"bafkrei…"`).
 * The same CID appears in the corresponding {@link StreamFileEnd} filterResult.
 */
export class CIDEncode implements FilterEncode {
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

  async config(): Promise<FilterConfigCID> {
    return {
      type: "CID.config",
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

  async result(): Promise<{ type: "CID.result"; cid: string }> {
    return { type: "CID.result", cid: this.#encodedCid ?? "" };
  }
}

// ── CIDDecode ─────────────────────────────────────────────────────────────────

export class CIDDecode implements FilterDecode {
  readonly #expectedCid?: string;

  /** @param expectedCid — if provided, decode() errors on mismatch */
  constructor(expectedCid?: string) {
    this.#expectedCid = expectedCid;
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    const expected = this.#expectedCid;
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

// ── CIDDecodeFactory ──────────────────────────────────────────────────────────

export class CIDDecodeFactory implements FilterDecodeFactory {
  async detect(_rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
    return filters.map((e) => {
      if (e.instance || !isFilterConfigCID(e.input)) return e;
      return { ...e, instance: new CIDDecode() };
    });
  }
}
