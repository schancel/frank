# @frank/codec

Browser-safe TypeScript reference codec for Frank deterministic CBOR, version 1. The protocol
semantics and status front door is [`docs/CASHWEB-PROTOCOL-SPEC.md`](../../docs/CASHWEB-PROTOCOL-SPEC.md).
`docs/protocol/cbor/README.md` owns the current encoding/validation profile, `*.cddl` owns exact
structure, and `vectors.schema.json` plus the committed vectors are executable proof.
This is the prototype package for issues #131 and #183; issue #136 adds the topic-event types.
Explicit CBOR topic writers and account registration use it, but normal topic and profile writers
still default to protobuf; no production DM or mailbox path uses it. The Rust codec is
`backend/cashweb/frank-cbor`.
It is not imported here. Shared vectors under `docs/protocol/cbor/vectors/` are
the compatibility contract.

Provisional directory schema4/min-reader4 is available only through explicit
`previewDirectoryContext()` opt-in. `defaultContext()` stays reader2/type4
schema3, so existing routes reject required v4 children. The bounded
`verifyPreviewDirectoryEvidence(bytes, expectedNetwork)` facade returns
`kind: 'preview-directory-signed-evidence'`, exact statement/wrapper frames,
T1 (`statementHash`), T2 (`signatureDigest`) and separate message-DH/stamp
roles and generations. It verifies canonical structure, stateless preview
semantics, network and the exact subject signature. It does not admit a
trusted directory head. Generic `full` validation of preview records fails
with `FrankContextError`; prior-state validation is deliberately unavailable
in the bounded facade.

Trusted anchors, clock/freshness, authenticated relay tuples, contiguous
history/predecessors, schema order, independent generation increments,
historical no-reuse, cumulative budgets, forks and atomic acceptance remain
the runtime successor's obligations. See the [allocated profile and precise
boundary](../../docs/protocol/cbor/README.md#provisional-directory-preview).
The shared `vectors/directory-preview.json` has codec-only expectations over
the reviewed synthetic #719 bytes; it is not the proposal's state-policy
runner and does not demonstrate persistence, routing or DM activation.

## Encryption suites

This package owns Frank-CBOR field layout. Type-5 schema 2 allocates production
suite 1 to crypto-box authenticated XChaCha20-Poly1305. Suite 65535 remains
reserved for schema-1 opaque proof-vector ciphertext (spec S2c).
Private crypto-box registry ids `0xFE01`, `0xFE02`, and `0xFE03` are not
Frank-CBOR encryption-suite allocations. A crypto-box envelope is not a frame.
This codec marshals and unmarshals frames. A digest or
ciphertext is a byte array passed into `@frank/nakamoto` or `@frank/crypto-box`.
Nakamoto still owns the HD nodes, keys, and transactions that do the signing.
Nakamoto does not parse CBOR. Crypto-box does not parse Frank/CashWeb CBOR; it
privately parses only its fixed-schema envelope CBOR. Callers do not write
crypto-box registry ids into a version-1 encryption-suite field.

## Scope

Implemented (against the spec as merged on main):

- Restricted canonical-CBOR encoder (independent of Map insertion order, `bigint` for
  u64/i64) and the two-pass strict validator/decoder (pass A syntax and resources, pass B
  canonicality and profile class).
- FRNK frame encode/parse and section 9 **stages 1-9**, plus stage 10.6 for type-2 roots:
  root limits, header, version, length, envelope and payload CBOR, envelope checks, the V6
  decision, typed structure 8.1-8.4
  (recursive child opening with shared R1 counters, required-type and open-field children),
  and the stage 9 semantic checks that need no cryptography (S3-S10 ordering, uniqueness,
  linkage, contiguity).
- T1 content hash, T1a digest, and the pure hashes T3, T4, and T7 (`topicVoteCommitment`).
- Account-registration statements at type-4 schema 3, with the M2/M3/M6 timestamp, expiry, and
  Keccak-256 address utilities. The `full` operation verifies every type-2 signature entry and
  key-transition authorization for algorithm 1 as strict-DER low-S secp256k1 ECDSA over the
  frozen T2/T2a digests. Allocated algorithms 2/3/16 fail as `unsupported` before verification.
- Topic events: type 9 (post), type 10 (post plus its burn transaction), and type 11 (vote),
  with the R6 limits and the S11 network equality. The burn transaction is opaque bytes here;
  verifying it against the chain (T8) belongs to the relay, not to this codec.
- The stamp fields of #198 through stage 9: type-5 schema-1 fields 6-8 and schema-2 fields 5-7
  (`E`, `X`, the DLEQ proof) with the
  T3b encoding rules (33-byte compressed point on the curve, `x < p`, prefix 02/03; proof
  scalars `c` and `s` each in `1..n-1`), the type-4 schema-2 stamp key (field 8, required from
  schema 2, undefined in schema 1, key type 1, S10a.1), the same-subject schema order (S10a.2),
  and the S8/S9 rule that the delivery destination is the stamp key `P'` and is not compared with
  the type-5 recipient. `defaultContext()` is reader version 2 with type 4 at schema 3.
- Retention: exact original frame bytes at every level, unknown types/frame versions/fields.
- Reciprocal check of Rust-originated proof fixtures in
  `docs/protocol/cbor/vectors/rust-origin.json` (`test/rust-origin.jest.test.ts`).
  The Rust codec itself is `backend/cashweb/frank-cbor` and is not imported here.

Not implemented:

- Stage 10.1-10.5 for type-1 roots: no payment verification or decrypted-frame opening. Calling
  `full` for type 1 fails with a context error; stage 10.6 is implemented only for type 2.
- T3a stamp destination derivation and the T3b DLEQ proof (verify or prove), the S10a.4 binding
  of `P'` to a directory state, and the remaining type-1 `cryptographic` checks. The type-5 stamp
  fields are checked for encoding only; a well-formed but wrong proof is accepted at `typed`.
- The stage-10 vectors of the #198 type-1 list (README section 10). The typed ones are in the
  manifest. The separate account-registration corpus covers type-2 stage 10.6.

## API

Entry point `src/index.ts`.

- `encodeCanonical(value)`, `decodeCanonical(bytes)`, `isValidCanonical(bytes)`, `cborMap`.
- `encodeFrame({typeId, schemaVersion, minReaderVersion}, payload | {bytes})`, `wrapFrame`.
- `validateFrame(bytes, context)` (alias `parseFrame`) with `defaultContext()`. Operations:
  `frame` (stages 1-4), `generic` (1-7), `typed` (1-9), and `full` (type-2 stage 10.6).
  Returns a `FrameOnly`, a
  `ParsedFrame` (exact `frame` bytes, generic `payload`, `typed` projection, `projection`
  `exact` or `newer-schema`) or a `RetainedFrame`. Failures throw `FrankCodecError` with
  `category`, `stage`, `pass`, `location`. A bad context throws `FrankContextError`.
- `contentHash`, `messageContentDigest`, `directorySignatureDigest`,
  `keyTransitionSignatureDigest`, `recipientPayloadDigest`, `paymentCommitment`,
  `topicVoteCommitment`, `commonTranscript`, `toHex`, `fromHex`; plus the exported registration
  timestamp/address utilities and strict-DER/signature-verification helpers.
- Topic-event writers (README T7, T8): `encodeTopicPost`, `topicPostHash`, `topicBurnCommitment`,
  `topicBurnCalldata` (`"TPIC" || 02 || direction || commitment`), `topicPostBurnCalldata` (fixed to
  `up`: a post's own burn MUST be an up-vote, T8), `encodeTopicPostSubmission`,
  and `encodeTopicVote`. Each validates what it wrote with the reader's typed validation, and the
  order is fixed by T7: encode the post, derive its commitment, sign the burn for it, then wrap.
  `encodeTopicPostSubmission` and `encodeTopicVote` take the signed burn transaction as opaque
  bytes: they do not check that its calldata carries the derived commitment (or, for a post, that
  the burn is an up-vote); the relay checks and rejects a mismatch before broadcasting. Writer
  misuse (a lone surrogate, an unknown direction, a wrong-length or non-`Uint8Array` commitment,
  or any argument of the wrong JavaScript type) throws `FrankCodecError`.
  The wallet topic clients call them only when explicitly configured with
  `topicWriteFormat: 'cbor'`; their default remains protobuf.

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
  stages 1-7 of the root frame and T1 over the manifest, and T1/T7 over
  `vectors/topic-commitments.json`. It needs Python 3 with `jsonschema`.
  It also evaluates the account-registration corpus through stage 10.6 and independently
  recomputes its value vectors (including ECDSA and Keccak-256). It reports how many main-manifest
  cases it evaluates (root-frame stages 1-7 category, retention, or a
  typed accept's T1 hash) and how many it does NOT evaluate (typed cases rejected at stages
  8-9 or inside an opened child, which it does not implement).

## Corpus

`docs/protocol/cbor/vectors/manifest.json` conforms to `vectors.schema.json`. It is generated
from `fixtures/` (`builders.ts`, `cases.ts`, `manifest.ts`) and a Jest test fails when it is
stale. Regenerate with `FRANK_UPDATE_VECTORS=1 yarn test`, which also rewrites
`docs/protocol/cbor/vectors/topic-commitments.json` (the T1 and T7 hashes of the topic events,
recomputed by the Rust codec and by `scripts/crosscheck.py`). Cases without their own
`supported` list run against the reader that predates the topic types, so the corpus written
before #136 is unchanged byte for byte; `test/topic.jest.test.ts` proves those cases behave the
same when the topic types are listed. `fixtures/checker.ts` enforces the
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
- The main manifest has no `full`, `cryptographic` or `cross_language_roundtrip` vectors; the
  separate account-registration corpus has the type-2 `full` and `cryptographic` cases. The
  `opaque_retention` pair relation is unused.

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

## Structured Forum codec

`encodeForumPost` explicitly emits type9 schema2/min2. Existing `encodeTopicPost({body})`
still emits opaque schema1. `validateFrame` returns schema-discriminated content with the
whole original body/frame retained, including compatible future placeholders. Types12–15
project relay observations and exact cursor bindings; they do not allocate a read-frame T1.
`encodeForumReadFrame`, the cursor helpers and `matchForumOperation`/`matchForumView`/
`matchForumPage` are pure boundary tools. A matching response is not independently verified
chain evidence and never releases a wallet lease. Normal writers/routes and retained snapshot
publication remain #769's server work under #675; #770 owns the whole normal-path
switch and predecessor removal. Active shared vectors are in
`docs/protocol/cbor/vectors/forum-content-read.json`.

## Universal State Channels (Type 24)

Universal state channels (`channel-update-item`, Type 24) provide off-chain state execution for multi-network balance allocations and peer-to-peer interactive turns (gaming, swaps, raffles) with signed state digests and deterministic client folding.

