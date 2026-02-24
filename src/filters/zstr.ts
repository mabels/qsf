// ZStrFilter — compression via the Web Streams CompressionStream /
// DecompressionStream APIs (browsers and Node.js ≥ 18).
// Codec is stored in the manifest so the reader picks the right format.

import type { FilterConfigZStr } from "../manifest-types.js";
import type { Filter } from "./types.js";

export type ZStrCodec = "deflate" | "deflate-raw" | "gzip";

export class ZStrFilter implements Filter {
  readonly #codec: ZStrCodec;

  constructor(codec: ZStrCodec = "deflate") {
    this.#codec = codec;
  }

  config(): FilterConfigZStr {
    return { type: "ZStr", codec: this.#codec };
  }

  result(): unknown {
    return { codec: this.#codec };
  }

  encode(): TransformStream<Uint8Array, Uint8Array> {
    return new CompressionStream(this.#codec) as TransformStream<Uint8Array, Uint8Array>;
  }

  decode(): TransformStream<Uint8Array, Uint8Array> {
    return new DecompressionStream(this.#codec) as TransformStream<Uint8Array, Uint8Array>;
  }
}
