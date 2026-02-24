// CIDCollector — coordinates a group of CIDFilters and computes a combined CID
// from their results in declaration order.
//
// Usage:
//   const col = new CIDCollector();
//   const dataCid = col.filter();   // slot 0
//   const metaCid = col.filter();   // slot 1
//
//   await writer.write([
//     { stream: dataStream, filters: [dataCid, new ZStrFilter(), new EncryptFilter(key, keyId)] },
//     { stream: metaStream, filters: [metaCid] },
//   ]);
//
//   const fileName = await col.result(); // combined CID — use as file name

import { sha256 } from "@noble/hashes/sha2.js";
import { CID } from "multiformats";
import { create as createDigest } from "multiformats/hashes/digest";
import * as raw from "multiformats/codecs/raw";
import { CIDFilter } from "./cid.js";

const SHA2_256 = 0x12;

export class CIDCollector {
  readonly #slots: CIDFilter[] = [];

  // Creates a CIDFilter registered at the next slot in declaration order.
  filter(opts?: { combineId?: string }): CIDFilter {
    const f = new CIDFilter(opts);
    this.#slots.push(f);
    return f;
  }

  // Awaits all member CID promises (in declaration order), then computes a
  // combined CIDv1 over SHA2-256(JSON.stringify([cid0, cid1, ...])).
  // Returns the combined CID string — suitable for use as a file name.
  async result(): Promise<string> {
    if (this.#slots.length === 0) throw new Error("CIDCollector has no registered filters");
    const memberCids = await Promise.all(this.#slots.map((f) => f.cidPromise));
    const input = new TextEncoder().encode(JSON.stringify(memberCids));
    const digest = createDigest(SHA2_256, sha256(input));
    return CID.create(1, raw.code, digest).toString();
  }

  // Member CIDs in declaration order — available after result() resolves.
  async memberCids(): Promise<string[]> {
    return Promise.all(this.#slots.map((f) => f.cidPromise));
  }
}
