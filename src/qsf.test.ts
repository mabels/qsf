import { describe, it, expect } from "vitest";
import { string2stream, stream2string, uint8array2stream } from "@adviser/cement";
import { QsfWriter } from "./writer.js";
import {
  QsfReader,
  isStreamFileBegin,
  isStreamFileEnd,
  streamIdOf,
  type QsfStreamEvt,
  type StreamFileBegin,
} from "./reader/index.js";
import { CIDEncode } from "./filters/cid.js";
import { CIDCollector } from "./filters/cid-collector.js";
import { ZStrEncode } from "./filters/zstr.js";
import { TestEncryptEncode, TestEncryptDecodeFactory } from "./filters/test-encrypt.js";
import type { FilterDecodeFactory } from "./filters/types.js";
import { isFilterResultCID } from "./manifest-types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeToBuf(
  entries: Parameters<QsfWriter["write"]>[0],
): Promise<{ buf: Uint8Array; results: Awaited<ReturnType<QsfWriter["write"]>> }> {
  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({
    write(c): void {
      chunks.push(c);
    },
  });
  const writer = new QsfWriter();
  const results = await writer.write(entries, sink);
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return { buf, results };
}

async function drain(buf: Uint8Array, decoders?: FilterDecodeFactory[]): Promise<QsfStreamEvt[]> {
  const evts: QsfStreamEvt[] = [];
  const reader = QsfReader(uint8array2stream(buf), decoders ? { decoders } : undefined).getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    evts.push(value);
  }

  // Every StreamFileBegin must have exactly one matching StreamFileEnd and vice versa.
  const begins = evts.filter(isStreamFileBegin);
  const ends = evts.filter(isStreamFileEnd);
  expect(begins.length, "StreamFileBegin count").toBe(ends.length);
  for (const begin of begins) {
    const sid = streamIdOf(begin);
    const matched = ends.filter((e) => streamIdOf(e) === sid);
    expect(matched.length, `StreamFileEnd for streamId ${sid}`).toBe(1);
  }

  return evts;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("QsfWriter -> QsfReader roundtrip", () => {
  it("no filters — raw passthrough", async () => {
    const { buf } = await writeToBuf([{ stream: string2stream("hello raw world"), encoders: [] }]);

    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(config).toBeDefined();

    expect(await stream2string(config.decode())).toBe("hello raw world");
  });

  it("CID filter — data unchanged, CID verifiable", async () => {
    const content = "content with cid";
    const cidFilter = new CIDEncode();

    const { buf } = await writeToBuf([{ stream: string2stream(content), encoders: [cidFilter] }]);
    const writtenCid = await cidFilter.cidPromise;
    expect(writtenCid).toMatch(/^bafkrei/);

    const evts = await drain(buf);
    const [end] = evts.filter(isStreamFileEnd);
    expect(end.filterResult).toEqual([{ type: "CID.result", cid: writtenCid }]);

    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode())).toBe(content);
  });

  it("filterResult — all three filters report results in StreamFileEnd", async () => {
    const content = "filterResult test";
    const tf = await TestEncryptEncode.create();

    const { buf } = await writeToBuf([{ stream: string2stream(content), encoders: [new CIDEncode(), new ZStrEncode(), tf] }]);

    const evts = await drain(buf, [new TestEncryptDecodeFactory()]);
    const [end] = evts.filter(isStreamFileEnd);
    expect(end.filterResult).toHaveLength(3);
    expect(end.filterResult[0].type).toBe("CID.result");
    expect((end.filterResult[0] as { type: string; cid: string }).cid).toMatch(/^bafkrei/);
    expect(end.filterResult[1]).toEqual({ type: "ZStr.result", codec: "deflate" });
    expect(end.filterResult[2].type).toBe("TestEncrypt.result");
  });

  it("ZStr filter — compressed on disk, decompressed on read", async () => {
    const content = "compress me ".repeat(200);

    const { buf, results } = await writeToBuf([{ stream: string2stream(content), encoders: [new ZStrEncode()] }]);
    expect(results[0].length).toBeLessThan(new TextEncoder().encode(content).byteLength);

    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode())).toBe(content);
  });

  it("TestEncrypt filter — ciphertext on disk, plaintext on read", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "top secret payload";

    const { buf } = await writeToBuf([{ stream: string2stream(content), encoders: [tf] }]);

    const evts = await drain(buf, [new TestEncryptDecodeFactory()]);
    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode())).toBe(content);
  });

  it("CID + ZStr + TestEncrypt — full pipeline roundtrip", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "full pipeline content ".repeat(100);
    const cidFilter = new CIDEncode();

    const { buf, results } = await writeToBuf([{ stream: string2stream(content), encoders: [cidFilter, new ZStrEncode(), tf] }]);
    const writtenCid = await cidFilter.cidPromise;
    expect(results[0].filterResult.find((f) => isFilterResultCID(f) && f.cid === writtenCid)).toBeDefined();

    const evts = await drain(buf, [new TestEncryptDecodeFactory()]);
    const [result] = evts.filter(isStreamFileEnd);
    expect(result.filterResult.find((f) => isFilterResultCID(f) && f.cid === writtenCid)).toBeDefined();

    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode())).toBe(content);
  });

  it("combineId — CIDCollector combines data + meta CIDs into a file name", async () => {
    const tf = await TestEncryptEncode.create();

    const col = new CIDCollector();
    const dataFilter = col.filter();
    const metaFilter = col.filter();

    const { buf } = await writeToBuf([
      {
        stream: string2stream("the actual document content"),
        encoders: [dataFilter, new ZStrEncode(), tf],
        combineId: "rec-1",
      },
      {
        stream: string2stream(JSON.stringify({ primaryKey: "doc-42", filename: "report.pdf" })),
        encoders: [metaFilter, new ZStrEncode()],
        combineId: "rec-1",
      },
    ]);

    const fileName = await col.result();
    expect(fileName).toMatch(/^bafkrei/);

    const [dataCid, metaCid] = await col.memberCids();
    expect(dataCid).not.toBe(metaCid);

    const evts = await drain(buf, [new TestEncryptDecodeFactory()]);
    const configs = evts.filter(isStreamFileBegin);
    const results = evts.filter(isStreamFileEnd);

    const dataResult = results.find((r) => r.filterResult.some((f) => isFilterResultCID(f) && f.cid === dataCid));
    expect(dataResult).toBeDefined();
    const metaResult = results.find((r) => r.filterResult.some((f) => isFilterResultCID(f) && f.cid === metaCid));
    expect(metaResult).toBeDefined();
    const dataConfig = configs.find((c) => streamIdOf(c) === streamIdOf(dataResult as QsfStreamEvt));
    expect(dataConfig).toBeDefined();
    const metaConfig = configs.find((c) => streamIdOf(c) === streamIdOf(metaResult as QsfStreamEvt));
    expect(metaConfig).toBeDefined();

    expect(await stream2string((dataConfig as StreamFileBegin).decode())).toBe("the actual document content");

    interface MetaJson {
      primaryKey: string;
      filename: string;
    }
    const meta = JSON.parse(await stream2string((metaConfig as StreamFileBegin).decode())) as MetaJson;
    expect(meta.primaryKey).toBe("doc-42");
    expect(meta.filename).toBe("report.pdf");

    expect(configs.every((c) => c.combineId === "rec-1")).toBe(true);
  });

  it("multiple independent streams in one file", async () => {
    const contents = ["alpha", "beta", "gamma"];

    const { buf, results } = await writeToBuf(contents.map((c) => ({ stream: string2stream(c), encoders: [new CIDEncode()] })));
    expect(results).toHaveLength(3);

    const evts = await drain(buf);
    const configs = evts.filter(isStreamFileBegin);
    expect(configs).toHaveLength(3);

    for (let i = 0; i < contents.length; i++) {
      expect(await stream2string(configs[i].decode())).toBe(contents[i]);
    }
  });

  it("no TestEncrypt resolver — decode() throws for unresolved entry", async () => {
    const tf = await TestEncryptEncode.create();

    const { buf } = await writeToBuf([{ stream: string2stream("secret"), encoders: [new CIDEncode(), tf] }]);

    // No TestEncryptFilter in opts.filters — entry stays unresolved, decode() throws.
    // Note: any TestEncryptFilter resolver would succeed because detect() always
    // reconstructs the key from the serialised manifest entry.
    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(() => config.decode()).toThrow();
  });
});
