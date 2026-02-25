// QSF CLI — write and read .qsf files from the command line.
//
// Writer:
//   tsx src/cli.ts write --out out.qsf data.txt:cid,zstr meta.json:cid
//   tsx src/cli.ts write --out out.qsf data.txt:cid,encrypt
//
//   encoder tokens: cid | zstr | zstr:gzip | encrypt
//   encrypt embeds the key in the manifest (TestEncryptEncode — not for production).
//
// Reader:
//   tsx src/cli.ts read --src out.qsf --qrec --manifest --stream
//
//   --qrec      write stream<N>.frames.ndjson  (one frame header per line)
//   --manifest  write stream<N>.config.json + stream<N>.result.json
//   --stream    write stream<N>.bin  (decoded payload bytes)
//   --out       output directory (default: ".")

import { command, subcommands, run, string, option, flag, restPositionals } from "cmd-ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { uint8array2stream, stream2uint8array } from "@adviser/cement";
import { QsfWriter } from "./writer.js";
import { QsfReader, isStreamFileBegin, isStreamFileEnd, streamIdOf } from "./reader/index.js";
import { bytesToQRecEvt, isQRecEvt } from "./reader/bytes-to-qrecevt.js";
import { CIDEncode } from "./filters/cid.js";
import { ZStrEncode, type ZStrCodec } from "./filters/zstr.js";
import { TestEncryptEncode, TestEncryptDecodeFactory } from "./filters/test-encrypt.js";
import type { FilterEncode } from "./filters/types.js";
import { FrameType } from "./frame.js";

// ── encoder token parser ──────────────────────────────────────────────────────
// tokens: cid | zstr | zstr:gzip | zstr:deflate | encrypt

async function parseEncoders(tokens: string[]): Promise<FilterEncode[]> {
  const encoders: FilterEncode[] = [];
  for (const tok of tokens) {
    const [name, arg] = tok.split(":");
    switch (name) {
      case "cid":
        encoders.push(new CIDEncode());
        break;
      case "zstr":
        encoders.push(new ZStrEncode((arg ?? "deflate") as ZStrCodec));
        break;
      case "encrypt":
        encoders.push(await TestEncryptEncode.create());
        break;
      default:
        throw new Error(`unknown encoder: ${tok}`);
    }
  }
  return encoders;
}

// ── write command ─────────────────────────────────────────────────────────────

const writeCmd = command({
  name: "write",
  description: "Write streams into a .qsf file",
  args: {
    out: option({
      type: string,
      long: "out",
      short: "o",
      description: "Output .qsf file path",
    }),
    entries: restPositionals({
      type: string,
      description: "file:encoder,encoder,... entries (e.g. data.txt:cid,zstr meta.json:cid)",
      displayName: "entries",
    }),
  },
  handler: async ({ out, entries }): Promise<void> => {
    if (!entries.length) {
      console.error("Error: at least one entry required");
      process.exit(1);
    }

    const streamEntries: Parameters<QsfWriter["write"]>[0] = [];

    for (const entry of entries) {
      const colonIdx = entry.indexOf(":");
      const filePath = colonIdx === -1 ? entry : entry.slice(0, colonIdx);
      const filterTokens =
        colonIdx === -1
          ? []
          : entry
              .slice(colonIdx + 1)
              .split(",")
              .filter(Boolean);

      const fileBytes = new Uint8Array(await fs.readFile(filePath));
      const encoders = await parseEncoders(filterTokens);

      streamEntries.push({ stream: uint8array2stream(fileBytes), encoders });
      console.error(`[write] ${filePath} → encoders: [${filterTokens.join(", ") || "none"}]`);
    }

    const chunks: Uint8Array[] = [];
    const sink = new WritableStream<Uint8Array>({
      write(c): void {
        chunks.push(c);
      },
    });
    const writer = new QsfWriter();
    const results = await writer.write(streamEntries, sink);

    const total = chunks.reduce((s, c) => s + c.byteLength, 0);
    const buf = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) {
      buf.set(c, o);
      o += c.byteLength;
    }

    await fs.writeFile(out, buf);
    console.error(`[write] wrote ${buf.byteLength} bytes → ${out}`);
    for (const r of results) {
      console.error(`  stream ${r.streamId}: offset=${r.offset} length=${r.length}`);
    }
  },
});

// ── read command ──────────────────────────────────────────────────────────────

const readCmd = command({
  name: "read",
  description: "Read a .qsf file and dump selected layers",
  args: {
    src: option({
      type: string,
      long: "src",
      short: "s",
      description: "Input .qsf file path",
    }),
    out: option({
      type: string,
      long: "out",
      short: "o",
      description: "Output directory (default: .)",
      defaultValue: () => ".",
    }),
    qrec: flag({
      long: "qrec",
      description: "Write stream<N>.frames.ndjson (one frame header JSON per line)",
    }),
    manifest: flag({
      long: "manifest",
      description: "Write stream<N>.config.json and stream<N>.result.json",
    }),
    manifeststream: flag({
      long: "stream",
      description: "Write stream<N>.bin (decoded payload bytes)",
    }),
  },
  handler: async ({ src, out, qrec, manifest, manifeststream }): Promise<void> => {
    if (!qrec && !manifest && !manifeststream) {
      console.error("Error: specify at least one of --qrec, --manifest, --manifeststream");
      process.exit(1);
    }

    await fs.mkdir(out, { recursive: true });

    const buf = new Uint8Array(await fs.readFile(src));
    console.error(`[read] loaded ${src}: ${buf.byteLength} bytes`);

    // ── --qrec: dump raw frames ───────────────────────────────────────────────
    if (qrec) {
      const streamFiles = new Map<number, string[]>();
      const frameStream = bytesToQRecEvt(uint8array2stream(buf)).getReader();
      while (true) {
        const { done, value } = await frameStream.read();
        if (done) break;
        if (!isQRecEvt(value)) continue;
        const sid = value.header.streamId;
        if (!streamFiles.has(sid)) streamFiles.set(sid, []);
        const typeName = Object.entries(FrameType).find(([, v]) => v === value.header.type)?.[0] ?? value.header.type;
        const lines = streamFiles.get(sid) ?? [];
        streamFiles.set(sid, lines);
        lines.push(JSON.stringify({ type: typeName, streamId: sid, length: value.header.length }));
      }
      for (const [sid, lines] of streamFiles) {
        const path = join(out, `stream${sid}.frames.ndjson`);
        await fs.writeFile(path, lines.join("\n") + "\n");
        console.error(`[qrec] wrote ${lines.length} frames → ${path}`);
      }
    }

    // ── --manifest and --manifeststream via QsfReader ─────────────────────────
    if (manifest || manifeststream) {
      const allEvts: unknown[] = [];
      // TestEncryptDecodeFactory reconstructs any TestEncrypt key from the manifest.
      const reader = QsfReader(uint8array2stream(buf), { decoders: [new TestEncryptDecodeFactory()] }).getReader();
      console.error("[read] draining pipeline...");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allEvts.push(value);
        console.error(`[read] got event: ${JSON.stringify(value, null, 2)}`);
      }
      console.error(`[read] total events: ${allEvts.length}`);

      const configs = allEvts.filter(isStreamFileBegin);
      const results = allEvts.filter(isStreamFileEnd);

      if (manifest) {
        for (const cfg of configs) {
          const sid = streamIdOf(cfg);
          const path = join(out, `stream${sid}.config.json`);
          await fs.writeFile(
            path,
            JSON.stringify({ type: cfg.type, streamId: cfg.streamId, combineId: cfg.combineId, filters: cfg.filters }, null, 2),
          );
          console.error(`[manifest] wrote → ${path}`);
        }
        for (const res of results) {
          const sid = streamIdOf(res);
          const path = join(out, `stream${sid}.result.json`);
          await fs.writeFile(path, JSON.stringify(res, null, 2));
          console.error(`[manifest] wrote → ${path}`);
        }
      }

      if (manifeststream) {
        for (const cfg of configs) {
          const sid = streamIdOf(cfg);
          const path = join(out, `stream${sid}.bin`);
          const bytes = await stream2uint8array(cfg.decode());
          await fs.writeFile(path, bytes);
          console.error(`[stream] wrote ${bytes.byteLength} bytes → ${path}`);
        }
      }
    }
  },
});

// ── main ──────────────────────────────────────────────────────────────────────

const app = subcommands({
  name: "qsf",
  description: "QSF CLI — write and inspect .qsf files",
  cmds: { write: writeCmd, read: readCmd },
});

void run(app, process.argv.slice(2));
