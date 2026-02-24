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
import { CIDFilter } from "./filters/cid.js";
import { CIDCollector } from "./filters/cid-collector.js";
import { ZStrFilter } from "./filters/zstr.js";
import { EncryptFilter, keyFingerprint } from "./filters/encrypt.js";

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

async function drain(buf: Uint8Array): Promise<QsfStreamEvt[]> {
  const evts: QsfStreamEvt[] = [];
  const reader = QsfReader(uint8array2stream(buf)).getReader();
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

async function generateKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("QsfWriter -> QsfReader roundtrip", () => {
  it("no filters — raw passthrough", async () => {
    const { buf } = await writeToBuf([{ stream: string2stream("hello raw world"), filters: [] }]);

    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(config).toBeDefined();

    expect(await stream2string(config.decode(() => Promise.resolve(undefined)))).toBe("hello raw world");
  });

  it("CID filter — data unchanged, CID verifiable", async () => {
    const content = "content with cid";
    const cidFilter = new CIDFilter();

    const { buf, results } = await writeToBuf([{ stream: string2stream(content), filters: [cidFilter] }]);
    const writtenCid = await cidFilter.cidPromise;
    expect(writtenCid).toMatch(/^bafkrei/);

    const evts = await drain(buf);
    const [end] = evts.filter(isStreamFileEnd);
    expect(end.cid).toBe(writtenCid);
    expect(end.cid).toBe(results[0].cid);
    expect(end.filterResult).toEqual([{ filterName: "CID", result: { cid: writtenCid } }]);

    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode(() => Promise.resolve(undefined)))).toBe(content);
  });

  it("filterResult — all three filters report results in StreamFileEnd", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const content = "filterResult test";

    const { buf } = await writeToBuf([
      { stream: string2stream(content), filters: [new CIDFilter(), new ZStrFilter(), new EncryptFilter(key, keyId)] },
    ]);

    const evts = await drain(buf);
    const [end] = evts.filter(isStreamFileEnd);
    expect(end.filterResult).toHaveLength(3);
    expect(end.filterResult[0].filterName).toBe("CID");
    expect((end.filterResult[0].result as { cid: string }).cid).toMatch(/^bafkrei/);
    expect(end.filterResult[1]).toEqual({ filterName: "ZStr", result: { codec: "deflate" } });
    expect(end.filterResult[2]).toEqual({ filterName: "Encrypt", result: { keyId } });
  });

  it("ZStr filter — compressed on disk, decompressed on read", async () => {
    const content = "compress me ".repeat(200);

    const { buf, results } = await writeToBuf([{ stream: string2stream(content), filters: [new ZStrFilter()] }]);
    expect(results[0].length).toBeLessThan(new TextEncoder().encode(content).byteLength);

    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode(() => Promise.resolve(undefined)))).toBe(content);
  });

  it("Encrypt filter — ciphertext on disk, plaintext on read", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const content = "top secret payload";

    const { buf } = await writeToBuf([{ stream: string2stream(content), filters: [new EncryptFilter(key, keyId)] }]);

    const keyStore = (id: string): Promise<CryptoKey | undefined> => Promise.resolve(id === keyId ? key : undefined);
    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode(keyStore))).toBe(content);
  });

  it("CID + ZStr + Encrypt — full pipeline roundtrip", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);
    const content = "full pipeline content ".repeat(100);
    const cidFilter = new CIDFilter();

    const { buf, results } = await writeToBuf([
      { stream: string2stream(content), filters: [cidFilter, new ZStrFilter(), new EncryptFilter(key, keyId)] },
    ]);
    const writtenCid = await cidFilter.cidPromise;
    expect(results[0].cid).toBe(writtenCid);

    const keyStore = (id: string): Promise<CryptoKey | undefined> => Promise.resolve(id === keyId ? key : undefined);
    const evts = await drain(buf);
    const [result] = evts.filter(isStreamFileEnd);
    expect(result.cid).toBe(writtenCid);

    const [config] = evts.filter(isStreamFileBegin);
    expect(await stream2string(config.decode(keyStore))).toBe(content);
  });

  it("combineId — CIDCollector combines data + meta CIDs into a file name", async () => {
    const key = await generateKey();
    const keyId = await keyFingerprint(key);

    const col = new CIDCollector();
    const dataFilter = col.filter();
    const metaFilter = col.filter();

    const { buf } = await writeToBuf([
      {
        stream: string2stream("the actual document content"),
        filters: [dataFilter, new ZStrFilter(), new EncryptFilter(key, keyId)],
        combineId: "rec-1",
      },
      {
        stream: string2stream(JSON.stringify({ primaryKey: "doc-42", filename: "report.pdf" })),
        filters: [metaFilter, new ZStrFilter()],
        combineId: "rec-1",
      },
    ]);

    const fileName = await col.result();
    expect(fileName).toMatch(/^bafkrei/);

    const [dataCid, metaCid] = await col.memberCids();
    expect(dataCid).not.toBe(metaCid);

    const keyStore = (id: string): Promise<CryptoKey | undefined> => Promise.resolve(id === keyId ? key : undefined);
    const evts = await drain(buf);
    const configs = evts.filter(isStreamFileBegin);
    const results = evts.filter(isStreamFileEnd);

    const dataResult = results.find((r) => r.cid === dataCid);
    expect(dataResult).toBeDefined();
    const metaResult = results.find((r) => r.cid === metaCid);
    expect(metaResult).toBeDefined();
    const dataConfig = configs.find((c) => streamIdOf(c) === streamIdOf(dataResult as QsfStreamEvt));
    expect(dataConfig).toBeDefined();
    const metaConfig = configs.find((c) => streamIdOf(c) === streamIdOf(metaResult as QsfStreamEvt));
    expect(metaConfig).toBeDefined();

    expect(await stream2string((dataConfig as StreamFileBegin).decode(keyStore))).toBe("the actual document content");

    interface MetaJson {
      primaryKey: string;
      filename: string;
    }
    const meta = JSON.parse(
      await stream2string((metaConfig as StreamFileBegin).decode(() => Promise.resolve(undefined))),
    ) as MetaJson;
    expect(meta.primaryKey).toBe("doc-42");
    expect(meta.filename).toBe("report.pdf");

    expect(configs.every((c) => c.combineId === "rec-1")).toBe(true);
  });

  it("multiple independent streams in one file", async () => {
    const contents = ["alpha", "beta", "gamma"];

    const { buf, results } = await writeToBuf(contents.map((c) => ({ stream: string2stream(c), filters: [new CIDFilter()] })));
    expect(results).toHaveLength(3);

    const evts = await drain(buf);
    const configs = evts.filter(isStreamFileBegin);
    expect(configs).toHaveLength(3);

    for (let i = 0; i < contents.length; i++) {
      expect(await stream2string(configs[i].decode(() => Promise.resolve(undefined)))).toBe(contents[i]);
    }
  });

  it("wrong decrypt key — decryption throws", async () => {
    const key1 = await generateKey();
    const key2 = await generateKey();
    const keyId1 = await keyFingerprint(key1);

    const { buf } = await writeToBuf([
      { stream: string2stream("secret"), filters: [new CIDFilter(), new EncryptFilter(key1, keyId1)] },
    ]);

    const evts = await drain(buf);
    const [config] = evts.filter(isStreamFileBegin);
    await expect(stream2string(config.decode(() => Promise.resolve(key2)))).rejects.toThrow();
  });
});
