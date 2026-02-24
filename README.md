# @adviser/qsf

**QUIC Stream File Format** — a multiplexed streaming container format for binary streams.

Inspired by [QUIC](https://www.rfc-editor.org/rfc/rfc9000) variable-length integer framing, `qsf` lets you pack
multiple independent binary streams into a single file, each with its own composable filter pipeline
(content addressing, compression, encryption). The format is designed for streaming-first access:
a reader does not need to buffer the whole file to start consuming streams.

---

## Concepts

| Term                | Description                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **Stream**          | One logical byte sequence written with `QsfWriter` and read back as `StreamFileBegin` + `StreamFileEnd`            |
| **Filter**          | A transform applied during encode/decode: `CIDFilter`, `ZStrFilter`, `EncryptFilter`                               |
| **Manifest**        | JSON records (`stream.config`, `stream.result`) embedded between stream frames, carrying filter config and results |
| **StreamFileBegin** | Reader event: stream metadata + live `ReadableStream` + `decode(keyStore)` helper                                  |
| **StreamFileEnd**   | Reader event: CID, byte range, and per-filter result summaries (`filterResult`)                                    |

---

## Install

```sh
pnpm add @adviser/qsf
```

---

## Write

```ts
import { QsfWriter, CIDFilter, ZStrFilter, EncryptFilter, keyFingerprint } from "@adviser/qsf";
import { uint8array2stream } from "@adviser/cement";

const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
const keyId = await keyFingerprint(key);

const writer = new QsfWriter();
const chunks: Uint8Array[] = [];
const sink = new WritableStream<Uint8Array>({
  write(c) {
    chunks.push(c);
  },
});

const results = await writer.write(
  [
    {
      stream: uint8array2stream(myDocumentBytes),
      filters: [new CIDFilter(), new ZStrFilter(), new EncryptFilter(key, keyId)],
    },
    {
      stream: uint8array2stream(myMetaBytes),
      filters: [new CIDFilter(), new ZStrFilter()],
    },
  ],
  sink,
);

// results[0].cid — content address of the first stream (pre-compression, pre-encryption)
```

Filters are applied **left-to-right** during encoding and **right-to-left** during decoding.

---

## Read

```ts
import { QsfReader, isStreamFileBegin, isStreamFileEnd, streamIdOf } from "@adviser/qsf";
import { uint8array2stream, stream2uint8array } from "@adviser/cement";

const keyStore = async (keyId: string): Promise<CryptoKey | undefined> => myKeys.get(keyId);

const reader = QsfReader(uint8array2stream(fileBytes)).getReader();
while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  if (isStreamFileBegin(value)) {
    // value.filters — filter config from the manifest
    // value.stream  — raw (encoded) ReadableStream
    // value.decode(keyStore) — decoded ReadableStream (decompressed, decrypted, CID-verified)
    const bytes = await stream2uint8array(value.decode(keyStore));
  }

  if (isStreamFileEnd(value)) {
    // value.cid           — content address
    // value.filterResult  — [{ filterName, result }] per filter
    console.log(value.cid, value.filterResult);
  }
}
```

Use `streamIdOf(evt)` to correlate a `StreamFileBegin` with its `StreamFileEnd`.

---

## Filters

| Filter          | Encode                                  | Decode                | `result()`          |
| --------------- | --------------------------------------- | --------------------- | ------------------- |
| `CIDFilter`     | SHA2-256 CID over raw bytes             | Verifies CID on flush | `{ cid: string }`   |
| `ZStrFilter`    | `CompressionStream` (deflate/gzip)      | `DecompressionStream` | `{ codec: string }` |
| `EncryptFilter` | AES-GCM per-chunk (fresh IV each chunk) | AES-GCM per-chunk     | `{ keyId: string }` |

### CIDCollector

Group streams under a combined CID (e.g. data + metadata form one logical record):

```ts
import { CIDCollector, CIDFilter } from "@adviser/qsf";

const col = new CIDCollector();
await writer.write(
  [
    { stream: dataStream, filters: [col.filter(), new ZStrFilter()], combineId: "rec-1" },
    { stream: metaStream, filters: [col.filter()], combineId: "rec-1" },
  ],
  sink,
);

const fileName = await col.result(); // combined CID of both streams
```

---

## Injectable JSON codec

By default `QsfWriter` and `QsfReader` use `JSON.stringify` / `JSON.parse` with `TextEncoder` / `TextDecoder`
for manifest records. To plug in a custom codec (e.g. from `@adviser/cement`'s `SuperThis`):

```ts
const writer = new QsfWriter({
  ende: {
    encode: (v) => sthis.ende.json.encodeToUint8(v),
    decode: <T>(buf: Uint8Array) => sthis.ende.json.decodeUint8<T>(buf).Ok(),
  },
});
```

---

## File format overview

```
┌─ MANIFEST_ENTRY  stream.config  (streamId, filters)
├─ STREAM_HEADER   streamId
├─ STREAM_DATA     streamId, payload   ← one frame per encoded chunk
├─ STREAM_TRAILER  streamId, {cid}
└─ MANIFEST_ENTRY  stream.result  (streamId, cid, offset, length, filterResult)
   … repeated for each logical stream …
```

Each frame header uses QUIC-style variable-length integers (1/2/4/8 bytes) for `type`, `streamId`, and `length`.

---

## License

AFL-2.0
