export interface QsfEnde {
  encode(value: unknown): Uint8Array;
  decode<T>(buf: Uint8Array): T;
}

export const defaultEnde: QsfEnde = {
  encode: (value) => new TextEncoder().encode(JSON.stringify(value)),
  decode: <T>(buf: Uint8Array): T => JSON.parse(new TextDecoder().decode(buf)) as T,
};
