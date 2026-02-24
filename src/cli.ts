// QSF CLI — write and read .qsf files from the command line.
//
// Writer:
//   tsx src/cli.ts write --out out.qsf data.txt:cid,zstr meta.json:cid
//   tsx src/cli.ts write --out out.qsf data.txt:cid,encrypt:mykey.jwk
//
//   filter tokens: cid | zstr | zstr:gzip | encrypt:<keyfile.jwk>
//   if keyfile doesn't exist it is generated and saved.
//
// Reader:
//   tsx src/cli.ts read --src out.qsf --qrec --manifest --manifeststream --keydir ./keys
//
//   --qrec            write stream<N>.frames.ndjson  (one frame header per line)
//   --manifest        write stream<N>.config.json + stream<N>.result.json
//   --manifeststream  write stream<N>.bin  (decoded payload bytes)
//   --out             output directory (default: ".")

import { command, subcommands, run, string, option, flag, restPositionals } from "cmd-ts";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { uint8array2stream, stream2uint8array } from "@adviser/cement";
import { QsfWriter } from "./writer.js";
import { QsfReader, isStreamFileBegin, isStreamFileEnd, streamIdOf } from "./reader/index.js";
import { bytesToQRecEvt, isQRecEvt } from "./reader/bytes-to-qrecevt.js";
import { CIDFilter } from "./filters/cid.js";
import { ZStrFilter, type ZStrCodec } from "./filters/zstr.js";
import { EncryptFilter, keyFingerprint } from "./filters/encrypt.js";
import type { Filter } from "./filters/types.js";
import { FrameType } from "./frame.js";

// ── key helpers ───────────────────────────────────────────────────────────────

async function loadOrGenerateKey(keyFile: string): Promise<{ key: CryptoKey; keyId: string }> {
  let rawJwk: JsonWebKey;
  try {
    rawJwk = JSON.parse(await fs.readFile(keyFile, "utf8")) as JsonWebKey;
  } catch {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    rawJwk = await crypto.subtle.exportKey("jwk", key);
    await fs.writeFile(keyFile, JSON.stringify(rawJwk, null, 2));
    console.error(`[cli] generated new key → ${keyFile}`);
  }
  const key = await crypto.subtle.importKey("jwk", rawJwk, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
  const keyId = await keyFingerprint(key);
  return { key, keyId };
}

async function buildKeyStore(keyDir: string): Promise<(id: string) => Promise<CryptoKey | undefined>> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(keyDir);
  } catch {
    /* no dir */
  }
  const map = new Map<string, CryptoKey>();
  for (const f of entries.filter((e) => e.endsWith(".jwk"))) {
    const rawJwk = JSON.parse(await fs.readFile(join(keyDir, f), "utf8")) as JsonWebKey;
    const key = await crypto.subtle.importKey("jwk", rawJwk, { name: "AES-GCM" }, true, ["encrypt", "decrypt"]);
    const keyId = await keyFingerprint(key);
    map.set(keyId, key);
  }
  return (id): Promise<CryptoKey | undefined> => Promise.resolve(map.get(id));
}

// ── filter token parser ───────────────────────────────────────────────────────
// tokens: cid | zstr | zstr:gzip | zstr:deflate | encrypt:<keyfile.jwk>

async function parseFilters(tokens: string[]): Promise<Filter[]> {
  const filters: Filter[] = [];
  for (const tok of tokens) {
    const [name, arg] = tok.split(":");
    switch (name) {
      case "cid":
        filters.push(new CIDFilter());
        break;
      case "zstr":
        filters.push(new ZStrFilter((arg ?? "deflate") as ZStrCodec));
        break;
      case "encrypt": {
        if (!arg) throw new Error(`encrypt filter requires a key file: encrypt:<keyfile.jwk>`);
        const { key, keyId } = await loadOrGenerateKey(arg);
        filters.push(new EncryptFilter(key, keyId));
        break;
      }
      default:
        throw new Error(`unknown filter: ${tok}`);
    }
  }
  return filters;
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
      description: "file:filter,filter,... entries (e.g. data.txt:cid,zstr meta.json:cid)",
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
      const filters = await parseFilters(filterTokens);

      streamEntries.push({ stream: uint8array2stream(fileBytes), filters });
      console.error(`[write] ${filePath} → filters: [${filterTokens.join(", ") || "none"}]`);
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
      console.error(`  stream ${r.streamId}: cid=${r.cid || "(none)"} offset=${r.offset} length=${r.length}`);
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
    keyDir: option({
      type: string,
      long: "key-dir",
      description: "Directory containing .jwk key files for decryption",
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
      long: "manifeststream",
      description: "Write stream<N>.bin (decoded payload bytes)",
    }),
  },
  handler: async ({ src, out, keyDir, qrec, manifest, manifeststream }): Promise<void> => {
    if (!qrec && !manifest && !manifeststream) {
      console.error("Error: specify at least one of --qrec, --manifest, --manifeststream");
      process.exit(1);
    }

    await fs.mkdir(out, { recursive: true });

    const buf = new Uint8Array(await fs.readFile(src));
    console.error(`[read] loaded ${src}: ${buf.byteLength} bytes`);

    const keyStore = await buildKeyStore(keyDir);

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
      const reader = QsfReader(uint8array2stream(buf)).getReader();
      console.error("[read] draining pipeline...");
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        allEvts.push(value);
        console.error(`[read] got event: ${JSON.stringify((value as { type: string }).type)}`);
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
          const bytes = await stream2uint8array(cfg.decode(keyStore));
          await fs.writeFile(path, bytes);
          console.error(`[manifeststream] wrote ${bytes.byteLength} bytes → ${path}`);
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
