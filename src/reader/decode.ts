// Decode pipeline builder — composes Filter instances resolved by the detect() fold.
//
// buildDecodeStream() pipes the source through each resolved instance's decode()
// in reverse filter order (last filter wraps first).
// Every entry must have an instance — if one is missing, an error is thrown.

import type { FilterEntry } from "../filters/types.js";

export function buildDecodeStream(source: ReadableStream<Uint8Array>, entries: FilterEntry[]): ReadableStream<Uint8Array> {
  let result = source;
  for (const entry of [...entries].reverse()) {
    if (!entry.instance) {
      throw new Error(`No resolver for filter type '${entry.input.type}' — add a matching Filter to opts.filters`);
    }
    result = result.pipeThrough(entry.instance.decode());
  }
  return result;
}
