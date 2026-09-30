# @frank/codec

Browser-safe TypeScript reference codec for Frank deterministic CBOR, version 1. The
normative specification is `docs/protocol/cbor/` (README, `*.cddl`, `vectors.schema.json`).
This is the prototype package for issues #131 and #183. No production message, profile,
mailbox, topic or payment path uses it. Rollback is deleting this package and
`docs/protocol/cbor/vectors/`.

## Scope

Implemented (against the spec as merged on main):

- Restricted canonical-CBOR encoder (independent of Map insertion order, `bigint` for
  u64/i64) and the two-pass strict validator/decoder (pass A syntax and resources, pass B
  canonicality and profile class).
- FRNK frame encode/parse and section 9 **stages 1-9**: root limits, header, version, length,
  envelope and payload CBOR, envelope checks, the V6 decision, typed structure 8.1-8.4
  (recursive child opening with shared R1 counters, required-type and open-field children),
  and the stage 9 semantic checks that need no cryptography (S3-S10 ordering, uniqueness,
  linkage, contiguity).
- T1 content hash, T1a digest, and the pure hashes T3 and T4.
- Retention: exact original frame bytes at every level, unknown types/frame versions/fields.
- Reciprocal check of Rust-originated proof fixtures in
  `docs/protocol/cbor/vectors/rust-origin.json` (`test/rust-origin.jest.test.ts`).
  The Rust codec itself is `backend/cashweb/frank-cbor` and is not imported here.

Not implemented:

- Stage 10 (`full` operation): no signature or payment verification, no decrypted-frame
  opening, no `cryptographic` category.
- T3a stealth derivation and DLEQ.
- Type-5 fields 6-8 and directory-statement field 8, pending the stamp-key spec PR #200.
  Type 5 and type 4 are typed only for fields defined on main.

## API

Entry point `src/index.ts`.

- `encodeCanonical(value)`, `decodeCanonical(bytes)`, `isValidCanonical(bytes)`, `cborMap`.
- `encodeFrame({typeId, schemaVersion, minReaderVersion}, payload | {bytes})`, `wrapFrame`.
- `validateFrame(bytes, context)` (alias `parseFrame`) with `defaultContext()`. Operations:
  `frame` (stages 1-4), `generic` (1-7), `typed` (1-9). Returns a `FrameOnly`, a
  `ParsedFrame` (exact `frame` bytes, generic `payload`, `typed` projection, `projection`
  `exact` or `newer-schema`) or a `RetainedFrame`. Failures throw `FrankCodecError` with
  `category`, `stage`, `pass`, `location`. A bad context throws `FrankContextError`.
- `contentHash`, `messageContentDigest`, `recipientPayloadDigest`, `paymentCommitment`,
  `commonTranscript`, `toHex`, `fromHex`.

Returned frames are views of one private copy of the input; do not mutate them.

## Consumption

`package.json` `main` points at raw TypeScript (`src/index.ts`). There is no `exports` map,
`types` field or `dist` build, and the package is private. It works only through a
TypeScript-aware bundler or transformer. `yarn build:browser` produces an IIFE bundle in
`dist/` (ignored by git) for the browser check only.

## Commands (from `packages/frank-codec`)

- `yarn test` runs Jest.
- `yarn typecheck`, `yarn lint`, `yarn format` (Prettier with `app/.prettierrc.json`).
- `yarn check:browser` builds with esbuild, runs the bundle in a bare Node `vm` context
  (no Node globals), then loads it in headless Chrome. It needs a system Chrome/Chromium
  (`FRANK_CHROME` overrides the path); without one the Chrome step exits 3 (not verified).
- `yarn crosscheck` runs `scripts/crosscheck.py`, an independent Python implementation of
  stages 1-7 of the root frame and T1 over the manifest. It needs Python 3 with `jsonschema`.
  It reports how many cases it evaluates (root-frame stages 1-7 category, retention, or a
  typed accept's T1 hash) and how many it does NOT evaluate (typed cases rejected at stages
  8-9 or inside an opened child, which it does not implement).

## Corpus

`docs/protocol/cbor/vectors/manifest.json` conforms to `vectors.schema.json`. It is generated
from `fixtures/` (`builders.ts`, `cases.ts`, `manifest.ts`) and a Jest test fails when it is
stale. Regenerate with `FRANK_UPDATE_VECTORS=1 yarn test`. `fixtures/checker.ts` enforces the
README section 10 manifest-validity rules that JSON Schema cannot express.

Each reject case carries the optional `error_stage` (README section 10; other runners SHOULD compare it, category-only runners stay conformant), which `fixtures/cases.ts`
declares, the Jest tests assert, and the browser and Python checks compare.

## BCS falsification check

`bcs-falsification.result.json` records the #131 BCS check. It is produced by
`test/bcs-falsification.jest.test.ts` using `fixtures/mini-bcs.ts` (a minimal BCS
writer/reader whose output for a reference struct equals `@mysten/bcs` 2.1.2, pinned in
`fixtures/bcs-reference-v1.hex`; the library is not a dependency) and `fixtures/bcs.ts`
(fixture encodings). Regenerate with `FRANK_UPDATE_BCS_RESULT=1 yarn test`. Recorded results:
the BCS specification defines two's-complement signed integers but the library
@mysten/bcs 2.1.2 has no i64 constructor (the mini writer carries i64 as the equal u64 bytes); a field appended to the top-level struct was rejected by
a strict v1 reader and ignored (6 trailing bytes) by a lenient one; a field added to a struct
inside a vector made the v1 reader fail with `read past the end`; a new enum variant made it
fail with `unknown enum variant 3`; a future message-item type needed an explicit opaque
variant; with a length-prefixed extension blob present from v1 in a reduced five-field statement struct (not the
fixtures) the v1 reader accepted the v2 bytes.

## Known limits

- Only the four cases of the two pairs (`worked-type17-*`, `insertion-order-*`) use
  `paired_case`, and all four are accepts: 0 of the manifest's rejects are paired (the README
  section 10 SHOULD for reject vectors). Limit rules have at-limit accepts and one-over
  rejects by naming convention (`limit-*`, `r2-depth-*`), not by `paired_case`.
- Vectors deliberately not added (each needs more than a single-fault construction, or the
  spec leaves the stage or category open): an accept twin for 17 key-transition entries
  (16 valid transitions need a full S10 update); non-minimal 64-bit values inside key
  position at every width; 128-bit or bignum encodings (forbidden tags, covered by one
  vector); stage 10 vectors.

- Firefox and Safari were not run; only headless Chrome and a bare `vm` context.
- CI does not cover `packages/**`; run the commands above locally.
- The largest limit cases (MAX_ITEMS at-limit, 256 KiB text, ciphertext, 1 MiB type-1 and
  256 KiB type-2 frames, 4,096 facts, MAX_FRAME_BYTES) run in Jest only, not in the manifest.
- The direct-message fixture is a `typed` case with placeholder payment addresses; directory
  signature bytes are structurally valid filler.
- No `full`, `cryptographic` or `cross_language_roundtrip` vectors; the `opaque_retention`
  pair relation is unused.

## Spec ambiguities

The codec review of the merged spec found 17 places where the text was silent or
contradictory. Sixteen are now stated in the normative README
(`docs/protocol/cbor/README.md`), which is where to read them: tag heads and indefinite
chunks under R1 and section 9 pass A; the R2 256-item total under R2 and stage 8.4; open-field
retention under stage 8.4 and V6.1; the unreachable u64 bound under C7; the `framed-object`
size bound under stage 8.2; the S2b pairing for key-transition entries; nested wildcard maps
under C12; noncanonical-before-class under section 9 passes A and B; S10 for a type-4 root;
the retention flag, `error_stage`, and the prior-statement rule under section 10; the
zero-length body under F3; the R1 depth rationale and the type-5 boundary under section 6.
Where a clarification changes observable behaviour it is pinned by a manifest vector, and the
aggregate-size ones (more than 131,072 tags, an indefinite string of many chunks or over the
text limit) by `test/limits.jest.test.ts`, which the manifest omits for size.

One was waiting on the stamp-key PR (#200) and is now stated in the spec (S3):

- **S3 / T3a.4, payment ordering.** T3a.4 requires the sorted child indices to be exactly
  contiguous from 0 and S3 requires them unique, so the `transaction_id` tie-break can never
  decide. The codec keeps both checks; all are `semantic`.
