// Tests for the filter-injection API: opts.decoders + detect().
//
// Each FilterDecodeFactory in opts.decoders has its detect() called once per StreamConfigRecord.
// detect() receives the manifest record and the current FilterEntry[] (input +
// optional instance), and returns the updated array. Factories claim entries they
// recognise by stamping `instance`.  The fold runs left-to-right; first stamp wins.
//
// Built-in defaults [CIDFilter, ZStrFilter] are prepended automatically by QsfReader.
// For encryption, pass a TestEncryptFilter instance in opts.decoders.

import { describe, it, expect } from "vitest";
import { string2stream, stream2string, uint8array2stream } from "@adviser/cement";
import { QsfWriter } from "../writer.js";
import { QsfReader, isStreamFileBegin, type QsfStreamEvt } from "./index.js";
import { CIDEncode, CIDDecode, CIDDecodeFactory } from "../filters/cid.js";
import { ZStrEncode, ZStrDecode, ZStrDecodeFactory, type ZStrCodec } from "../filters/zstr.js";
import { TestEncryptEncode, TestEncryptDecodeFactory } from "../filters/test-encrypt.js";
import type { FilterDecode, FilterEntry } from "../filters/types.js";
import { isFilterConfigCID, isFilterConfigZStr, type StreamConfigRecord } from "../manifest-types.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

async function writeToBuf(entries: Parameters<QsfWriter["write"]>[0]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const sink = new WritableStream<Uint8Array>({
    write(c): void {
      chunks.push(c);
    },
  });
  await new QsfWriter().write(entries, sink);
  const total = chunks.reduce((s, c) => s + c.byteLength, 0);
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  return buf;
}

async function drainReader(stream: ReadableStream<QsfStreamEvt>): Promise<QsfStreamEvt[]> {
  const evts: QsfStreamEvt[] = [];
  const r = stream.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) break;
    evts.push(value);
  }
  return evts;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("QsfReader – filter injection via detect()", () => {
  // ── 1. TestEncryptFilter claims its own entry ───────────────────────────────

  it("TestEncryptDecodeFactory claims matching TestEncrypt entry", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "secret via detect";

    const buf = await writeToBuf([{ stream: string2stream(content), encoders: [tf] }]);

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new TestEncryptDecodeFactory()] }));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
  });

  // ── 2. Factory always reads key from manifest ──────────────────────────────

  it("TestEncryptDecodeFactory reads key from manifest without needing the original encoder", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "resolver path";

    const buf = await writeToBuf([{ stream: string2stream(content), encoders: [tf] }]);

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new TestEncryptDecodeFactory()] }));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
  });

  // ── 3. CID spy: custom factory+decode pair injected via detect() ────────────

  it("custom CID decode spy injected — spy decode() is called", async () => {
    const content = "cid spy content";
    const buf = await writeToBuf([{ stream: string2stream(content), encoders: [new CIDEncode()] }]);

    let spyDecodeCalled = false;
    // Implements both FilterDecodeFactory (detect) and FilterDecode (decode)
    // so it can stamp itself as the instance and intercept the decode call.
    class SpyCIDDecodeFactory extends CIDDecodeFactory implements FilterDecode {
      decode(): TransformStream<Uint8Array, Uint8Array> {
        spyDecodeCalled = true;
        return new CIDDecode().decode();
      }
      // Override detect() without the e.instance guard — overrides the prepended default.
      async detect(_rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
        return filters.map((e) => {
          if (!isFilterConfigCID(e.input)) return e;
          return { ...e, instance: this as FilterDecode };
        });
      }
    }

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new SpyCIDDecodeFactory()] }));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
    expect(spyDecodeCalled).toBe(true);
  });

  // ── 4. ZStr spy: custom factory+decode pair injected via detect() ───────────

  it("custom ZStr decode spy injected — spy decode() is called", async () => {
    const content = "compressible ".repeat(300);
    const buf = await writeToBuf([{ stream: string2stream(content), encoders: [new ZStrEncode("deflate")] }]);

    let spyDecompressCalled = false;
    class SpyZStrDecodeFactory extends ZStrDecodeFactory implements FilterDecode {
      #codec: ZStrCodec = "deflate";
      decode(): TransformStream<Uint8Array, Uint8Array> {
        spyDecompressCalled = true;
        return new ZStrDecode(this.#codec).decode();
      }
      // Override detect() without the e.instance guard — overrides the prepended default.
      async detect(_rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
        return filters.map((e) => {
          if (!isFilterConfigZStr(e.input)) return e;
          this.#codec = e.input.codec as ZStrCodec;
          return { ...e, instance: this as FilterDecode };
        });
      }
    }

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new SpyZStrDecodeFactory()] }));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
    expect(spyDecompressCalled).toBe(true);
  });

  // ── 5. Full pipeline: CID + ZStr + TestEncrypt ─────────────────────────────

  it("CID + ZStr + TestEncrypt full pipeline roundtrip", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "full pipeline";

    const buf = await writeToBuf([
      {
        stream: string2stream(content),
        encoders: [new CIDEncode(), new ZStrEncode(), tf],
      },
    ]);

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new TestEncryptDecodeFactory()] }));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
  });

  // ── 6. defaultFilters omitted → CID + ZStr resolved automatically ──────────

  it("omitting opts.decoders — CID and ZStr resolve without configuration", async () => {
    const content = "default filter path";
    const buf = await writeToBuf([
      {
        stream: string2stream(content),
        encoders: [new CIDEncode(), new ZStrEncode()],
      },
    ]);

    const evts = await drainReader(QsfReader(uint8array2stream(buf)));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
  });

  // ── 7. detect() called once per StreamConfigRecord — N streams → N calls ───

  it("detect() is called once per StreamConfigRecord", async () => {
    const contents = ["alpha", "beta", "gamma"];
    const buf = await writeToBuf(contents.map((c) => ({ stream: string2stream(c), encoders: [new CIDEncode()] })));

    const detectedRecs: StreamConfigRecord[] = [];

    class ObservingCIDDecodeFactory extends CIDDecodeFactory {
      async detect(rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
        detectedRecs.push(rec);
        return super.detect(rec, filters);
      }
    }

    const evts = await drainReader(QsfReader(uint8array2stream(buf), { decoders: [new ObservingCIDDecodeFactory()] }));
    expect(evts.filter(isStreamFileBegin)).toHaveLength(3);
    expect(detectedRecs).toHaveLength(3);
    expect(detectedRecs.every((r) => r.type === "stream.config")).toBe(true);
  });

  // ── 8. First stamp wins — second resolver skips already-claimed entries ─────

  it("fold order: first resolver to stamp an entry wins, later resolvers skip it", async () => {
    const tf = await TestEncryptEncode.create();
    const content = "first stamp wins";

    const buf = await writeToBuf([{ stream: string2stream(content), encoders: [tf] }]);

    let secondResolverCalled = false;

    class WatchingTestEncryptDecodeFactory extends TestEncryptDecodeFactory {
      async detect(rec: StreamConfigRecord, filters: FilterEntry[]): Promise<FilterEntry[]> {
        secondResolverCalled = true;
        return super.detect(rec, filters); // entry already has instance — super returns it unchanged
      }
    }

    const evts = await drainReader(
      QsfReader(uint8array2stream(buf), {
        // TestEncryptDecodeFactory claims first; Watching... runs but sees instance already set.
        decoders: [new TestEncryptDecodeFactory(), new WatchingTestEncryptDecodeFactory()],
      }),
    );
    const [begin] = evts.filter(isStreamFileBegin);
    expect(await stream2string(begin.decode())).toBe(content);
    expect(secondResolverCalled).toBe(true);
  });

  // ── 9. Missing resolver → buildDecodeStream throws ────────────────────────

  it("no TestEncrypt resolver in opts.decoders — decode() throws for unresolved entry", async () => {
    const tf = await TestEncryptEncode.create();
    const buf = await writeToBuf([{ stream: string2stream("secret"), encoders: [tf] }]);

    // No resolver — TestEncrypt entry stays unresolved, decode() throws synchronously.
    const evts = await drainReader(QsfReader(uint8array2stream(buf)));
    const [begin] = evts.filter(isStreamFileBegin);
    expect(() => begin.decode()).toThrow("No resolver for filter type 'TestEncrypt.config'");
  });
});
