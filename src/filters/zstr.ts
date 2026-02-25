// ZStr filter — three classes for the three filter roles.
//
// ZStrEncode        (FilterEncode)        — CompressionStream wrapper.
// ZStrDecode        (FilterDecode)        — DecompressionStream wrapper.
// ZStrDecodeFactory (FilterDecodeFactory) — detect() stamps ZStrDecode instances.

import { isFilterConfigZStr, type FilterConfigZStr, type StreamConfigRecord } from "../manifest-types.js";
import type { FilterEncode, FilterDecode, FilterDecodeFactory, FilterEntry } from "./types.js";

export type ZStrCodec = "deflate" | "deflate-raw" | "gzip";

// ── ZStrEncode ────────────────────────────────────────────────────────────────

export class ZStrEncode implements FilterEncode {
  readonly #codec: ZStrCodec;

  constructor(codec: ZStrCodec = "deflate") {
    this.#codec = codec;
  }

  async config(): Promise<FilterConfigZStr> {
    return { type: "ZStr.config", codec: this.#codec };
  }

  async result(): Promise<{ type: "ZStr.result"; codec: ZStrCodec }> {
    return { type: "ZStr.result", codec: this.#codec };
  }

  encode(): TransformStream<Uint8Array, Uint8Array> {
    return new CompressionStream(this.#codec) as TransformStream<Uint8Array, Uint8Array>;
  }
}

// ── ZStrDecode ────────────────────────────────────────────────────────────────

export class ZStrDecode implements FilterDecode {
  readonly #codec: ZStrCodec;

  constructor(codec: ZStrCodec) {
    this.#codec = codec;
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    return new DecompressionStream(this.#codec) as TransformStream<Uint8Array, Uint8Array>;
  }
}

// ── ZStrDecodeFactory ─────────────────────────────────────────────────────────

export class ZStrDecodeFactory implements FilterDecodeFactory {
  async detect(_rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
    return filters.map((e) => {
      if (e.instance || !isFilterConfigZStr(e.input)) return e;
      return { ...e, instance: new ZStrDecode(e.input.codec as ZStrCodec) };
    });
  }
}
