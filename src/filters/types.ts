import type { FilterConfig } from "../manifest-types.js";

export interface Filter {
  config(): FilterConfig;
  encode(): TransformStream<Uint8Array, Uint8Array>;
  decode(): TransformStream<Uint8Array, Uint8Array>;
  /** Called after encode() stream is fully consumed. Returns a serialisable result summary. */
  result(): unknown;
}
