// QUIC variable-length integer — RFC 9000 §16
//
// 2-bit prefix encodes byte width:
//   00 → 1B  (6-bit value,  max 63)
//   01 → 2B  (14-bit value, max 16 383)
//   10 → 4B  (30-bit value, max 1 073 741 823)
//   11 → 8B  (62-bit value, max 4 611 686 018 427 387 903)
//
// NOTE: 8B values beyond Number.MAX_SAFE_INTEGER (2^53 - 1) cannot be
// represented exactly as a JS number. Varint.fromBytes / fromObject will
// throw if an 8B-encoded value exceeds that bound. Use Varint.fromBigInt
// for those cases.

import { type } from "arktype";

export type VarintFormat = "1B" | "2B" | "4B" | "8B";

// ── Arktype schema for the JSON object representation ─────────────────────────

export const VarintType = type({
  f: '"1B" | "2B" | "4B" | "8B"',
  v: "string", // hex string, e.g. "0x9"
});
export type VarintObject = typeof VarintType.infer;

export function isVarintObject(x: unknown): x is VarintObject {
  return !(VarintType(x) instanceof type.errors);
}

// ── Varint class ──────────────────────────────────────────────────────────────

export class Varint {
  readonly value: number;

  constructor(value: number) {
    if (value < 0) throw new RangeError(`Varint must be non-negative, got ${value}`);
    if (!Number.isSafeInteger(value))
      throw new RangeError(`Varint value ${value} exceeds Number.MAX_SAFE_INTEGER — use Varint.fromBigInt`);
    this.value = value;
  }

  // ── Encode ──────────────────────────────────────────────────────────────────

  toBytes(): Uint8Array {
    const v = this.value;
    if (v < 64) {
      return new Uint8Array([v]);
    }
    if (v < 16_384) {
      return new Uint8Array([0x40 | (v >>> 8), v & 0xff]);
    }
    if (v < 1_073_741_824) {
      const buf = new Uint8Array(4);
      new DataView(buf.buffer).setUint32(0, (v | 0x80000000) >>> 0);
      buf[0] = (buf[0] & 0x3f) | 0x80;
      return buf;
    }
    // 8B — value fits in Number.MAX_SAFE_INTEGER (checked in constructor)
    const buf = new Uint8Array(8);
    new DataView(buf.buffer).setBigUint64(0, BigInt(v) | 0xc000_0000_0000_0000n);
    return buf;
  }

  toObject(): VarintObject {
    const bytes = this.toBytes();
    return {
      f: `${bytes.byteLength}B` as VarintFormat,
      v: `0x${this.value.toString(16)}`,
    };
  }

  // ── Decode ──────────────────────────────────────────────────────────────────

  static fromBytes(buf: Uint8Array, offset = 0): { varint: Varint; bytesRead: number } {
    const first = buf[offset];
    const prefix = (first & 0xc0) >> 6;

    switch (prefix) {
      case 0:
        return { varint: new Varint(first & 0x3f), bytesRead: 1 };

      case 1:
        return {
          varint: new Varint(((first & 0x3f) << 8) | buf[offset + 1]),
          bytesRead: 2,
        };

      case 2: {
        const dv = new DataView(buf.buffer, buf.byteOffset + offset, 4);
        return { varint: new Varint(dv.getUint32(0) & 0x3fff_ffff), bytesRead: 4 };
      }

      case 3: {
        const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
        const big = dv.getBigUint64(0) & 0x3fff_ffff_ffff_ffffn;
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RangeError(`8B varint value 0x${big.toString(16)} exceeds Number.MAX_SAFE_INTEGER — use Varint.fromBytesBig`);
        }
        return { varint: new Varint(Number(big)), bytesRead: 8 };
      }

      default:
        throw new Error("unreachable");
    }
  }

  static fromObject(obj: VarintObject): Varint {
    const value = Number(obj.v);
    if (!Number.isSafeInteger(value)) {
      throw new RangeError(`VarintObject value ${obj.v} exceeds Number.MAX_SAFE_INTEGER`);
    }
    return new Varint(value);
  }

  // ── BigInt variants for true 62-bit values ───────────────────────────────--

  static fromBigInt(value: bigint): { toBytes(): Uint8Array; toObject(): VarintObject } {
    if (value < 0n) throw new RangeError(`Varint must be non-negative, got ${value}`);
    if (value > 0x3fff_ffff_ffff_ffffn) throw new RangeError(`Varint value ${value} exceeds 62-bit maximum`);
    return {
      toBytes(): Uint8Array {
        const buf = new Uint8Array(8);
        new DataView(buf.buffer).setBigUint64(0, value | 0xc000_0000_0000_0000n);
        return buf;
      },
      toObject(): VarintObject {
        return { f: "8B", v: `0x${value.toString(16)}` };
      },
    };
  }

  static fromBytesBig(buf: Uint8Array, offset = 0): { value: bigint; bytesRead: number } {
    const first = buf[offset];
    if ((first & 0xc0) >> 6 !== 3) {
      const { varint, bytesRead } = Varint.fromBytes(buf, offset);
      return { value: BigInt(varint.value), bytesRead };
    }
    const dv = new DataView(buf.buffer, buf.byteOffset + offset, 8);
    const big = dv.getBigUint64(0) & 0x3fff_ffff_ffff_ffffn;
    return { value: big, bytesRead: 8 };
  }
}
