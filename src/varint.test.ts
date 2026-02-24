import { describe, it, expect } from "vitest";
import { Varint } from "./varint.js";

describe("Varint", () => {
  describe("1B (6-bit, max 63)", () => {
    it("encodes 0", () => expect(new Varint(0).toBytes()).toEqual(new Uint8Array([0x00])));
    it("encodes 9", () => expect(new Varint(9).toBytes()).toEqual(new Uint8Array([0x09])));
    it("encodes 63", () => expect(new Varint(63).toBytes()).toEqual(new Uint8Array([0x3f])));

    it("roundtrips 0", () => expect(Varint.fromBytes(new Varint(0).toBytes()).varint.value).toBe(0));
    it("roundtrips 63", () => expect(Varint.fromBytes(new Varint(63).toBytes()).varint.value).toBe(63));

    it("toObject", () => expect(new Varint(9).toObject()).toEqual({ f: "1B", v: "0x9" }));
    it("fromObject", () => expect(Varint.fromObject({ f: "1B", v: "0x9" }).value).toBe(9));
  });

  describe("2B (14-bit, max 16 383)", () => {
    it("encodes 64", () => {
      const bytes = new Varint(64).toBytes();
      expect(bytes.byteLength).toBe(2);
      expect((bytes[0] & 0xc0) >> 6).toBe(1); // prefix 01
    });
    it("roundtrips 64", () => expect(Varint.fromBytes(new Varint(64).toBytes()).varint.value).toBe(64));
    it("roundtrips 16383", () => expect(Varint.fromBytes(new Varint(16_383).toBytes()).varint.value).toBe(16_383));

    it("toObject", () => expect(new Varint(500).toObject()).toEqual({ f: "2B", v: "0x1f4" }));
    it("fromObject", () => expect(Varint.fromObject({ f: "2B", v: "0x1f4" }).value).toBe(500));
  });

  describe("4B (30-bit, max 1 073 741 823)", () => {
    it("encodes 16384", () => {
      const bytes = new Varint(16_384).toBytes();
      expect(bytes.byteLength).toBe(4);
      expect((bytes[0] & 0xc0) >> 6).toBe(2); // prefix 10
    });
    it("roundtrips 16384", () => expect(Varint.fromBytes(new Varint(16_384).toBytes()).varint.value).toBe(16_384));
    it("roundtrips 1073741823", () =>
      expect(Varint.fromBytes(new Varint(1_073_741_823).toBytes()).varint.value).toBe(1_073_741_823));

    it("toObject", () => expect(new Varint(1_073_741_823).toObject()).toEqual({ f: "4B", v: "0x3fffffff" }));
  });

  describe("8B (62-bit, up to MAX_SAFE_INTEGER)", () => {
    const large = 1_073_741_824; // first value requiring 8B

    it("encodes in 8 bytes", () => {
      expect(new Varint(large).toBytes().byteLength).toBe(8);
    });
    it("roundtrips", () => {
      expect(Varint.fromBytes(new Varint(large).toBytes()).varint.value).toBe(large);
    });
    it("roundtrips MAX_SAFE_INTEGER", () => {
      expect(Varint.fromBytes(new Varint(Number.MAX_SAFE_INTEGER).toBytes()).varint.value).toBe(Number.MAX_SAFE_INTEGER);
    });
  });

  describe("fromBigInt / fromBytesBig", () => {
    it("encodes a true 62-bit value", () => {
      const big = 0x3fff_ffff_ffff_ffffn;
      const bytes = Varint.fromBigInt(big).toBytes();
      expect(bytes.byteLength).toBe(8);
      const { value } = Varint.fromBytesBig(bytes);
      expect(value).toBe(big);
    });

    it("fromBytesBig falls through to normal for 1B", () => {
      const bytes = new Varint(7).toBytes();
      expect(Varint.fromBytesBig(bytes).value).toBe(7n);
    });
  });

  describe("guards", () => {
    it("rejects negative", () => expect(() => new Varint(-1)).toThrow(RangeError));
    it("rejects unsafe integer", () => expect(() => new Varint(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError));
    it("fromBytes 8B throws for > MAX_SAFE_INTEGER", () => {
      const bytes = Varint.fromBigInt(0x3fff_ffff_ffff_ffffn).toBytes();
      expect(() => Varint.fromBytes(bytes)).toThrow(RangeError);
    });
  });

  describe("bytesRead", () => {
    it("reports correct bytesRead for each width", () => {
      expect(Varint.fromBytes(new Varint(0).toBytes()).bytesRead).toBe(1);
      expect(Varint.fromBytes(new Varint(64).toBytes()).bytesRead).toBe(2);
      expect(Varint.fromBytes(new Varint(16_384).toBytes()).bytesRead).toBe(4);
      expect(Varint.fromBytes(new Varint(1_073_741_824).toBytes()).bytesRead).toBe(8);
    });

    it("reads at offset inside a larger buffer", () => {
      const prefix = new Uint8Array([0xde, 0xad]);
      const vbytes = new Varint(42).toBytes();
      const buf = new Uint8Array([...prefix, ...vbytes]);
      const { varint, bytesRead } = Varint.fromBytes(buf, 2);
      expect(varint.value).toBe(42);
      expect(bytesRead).toBe(1);
    });
  });
});
