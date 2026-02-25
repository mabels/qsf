import type { FilterConfig, StreamConfigRecord } from "../manifest-types.js";

export interface FilterEntry {
  input: FilterConfig;
  instance?: FilterDecode;
}

export interface FilterEncode {
  config(): Promise<FilterConfig>;
  encode(): TransformStream<Uint8Array, Uint8Array>;
  result(): Promise<{ type: string } | undefined>;
}

export interface FilterDecode {
  decode(): TransformStream<Uint8Array, Uint8Array>;
}

export interface FilterDecodeFactory {
  detect(rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]>;
}
