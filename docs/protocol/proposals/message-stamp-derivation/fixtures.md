# Fixture evidence and bounded gates

`vectors.json` is a shared public synthetic corpus, not an active conformance
manifest. Its status is `PROPOSED-NOT-ALLOCATED`; roots and private keys must never
be used for funds. `accounts` contains two public account roots, five literal
HKDF transcripts each, and 16 leaves each: fixed auth/main, funding/change at
0/1/max, and message/stamp at 0/1/2/max. Every leaf includes exact seed, serialized
path indices, 32-byte private scalar and chain code, 33-byte compressed SEC1
point and EVM address. M's address is comparison evidence only, not permission
to treat M as a funding account.

Each account has four unsigned, exact proposed type-4 frame/T1 constructions:
bootstrap, first stamp rotation, second stamp rotation, and M-only rotation.
They use the already proposed schema4/min4 shape and predecessor commitment.
No allocation is changed, and no relay is contacted. `message_generation` maps
to field 11 (`mailbox_key_generation`); `stamp_generation` maps to field 12.
The max leaves are numeric boundary probes, not a claim to have accepted
billions of directory updates beyond #719's 4096-statement preview cap.

TS uses Node/OpenSSL HMAC and secp256k1 for an explicit exact-index BIP32
implementation; every natural leaf is additionally checked with existing
ethers HDNodeWallet. Rust independently rebuilds HKDF and BIP32 using RustCrypto
HMAC/SHA-2 and libsecp256k1 scalar addition/public-point derivation, starting from
the account root rather than trusting TS's root or leaf bytes. Both compare
every exact private/public/chain-code/path/seed value against the shared corpus.
Rust independently decodes the frame, compares its role/generation fields and
predecessor, and recomputes T1 with the existing generic `frank-cbor` transcript.
It does not invoke an active schema4 acceptance result.

The existing ethers implementation is only a natural-vector cross-check; its
invalid-scalar behavior is not this proposal's specification. Exact-index
implementations explicitly reject IL >= n and child zero before returning a
result. Injected outputs at `80000000` and `ffffffff` check those errors without
calling a library that might reduce/retry. A zero child tweak is valid primitive
arithmetic; the separate no-reuse check rejects its publication if it would
recur as an old role point. An active adopter must carry these exact failure
semantics to its production boundary, including no partial state commit.

| Evidence | TypeScript | Independent Rust |
| --- | --- | --- |
| 10 frozen root inputs/outputs | Existing root API + independent Node HMAC | RustCrypto HMAC; compare original frozen corpus |
| 32 role/funding/change leaves | Explicit BIP32 + ethers comparison | Explicit BIP32 + libsecp256k1; exact private/public/chain/path/seed |
| 8 existing wallet address answers | Compare reviewed independent wallet KATs | Exact scalar/point agreement; EVM address encoding not repeated |
| 8 directory tuples | Build exact generic type4/T1 | Canonical frame, fields, predecessor and exact T1 |
| 15 generation inputs | Exact decimal parser; includes first rejected and uint64 limits | Independent parser and same outcomes |
| 10 invalid/master/child boundary probes | Explicit injected HMAC bytes; no retry | Same injection corpus, independent scalar validity/addition |
| 47 restore/admission cases | Metadata IDs/codes/interpretation/length, roles, paths, network/T1, independent current/previous derivation, retirement | Independently implemented same outcomes |
| 4 no-reuse cases | Distinct next point, same/negated retired point, cross-role reuse | Independent x-coordinate comparison |
| 8 baseline artifact hashes (7 active source/vector files and the prior directory proposal) | SHA256 pins | Independently checked SHA256 pins |

The restore corpus is a bounded local derivation/policy model whose starting
snapshots represent **already authenticated** directory state. It does not
implement signature verification, freshness, rollback protection, a database,
archive ciphertext decryption, T3a payments, provider capabilities or live
services. Those are downstream gates. Its `archive-only` result and derived
retired secrets never confer admission. Pair loss is an explicit trusted local
state condition, not a request bit a remote caller may set to bypass checks.

There is no factory gate script at this base. From repository root with existing
dependencies available, the equivalent isolated stages are:

```sh
# typecheck
node node_modules/typescript/bin/tsc -p packages/domain-roots/proposals/message-stamp-derivation/tsconfig.json
# fixtures / frozen roots and paths / exact directory tuples / hostile policy
node packages/domain-roots/proposals/message-stamp-derivation/run.cjs
node packages/domain-roots/scripts/check-vectors.mjs
# independently locked offline Rust fixtures
cargo run --offline --locked --manifest-path backend/cashweb/frank-cbor/proposals/message-stamp-derivation/Cargo.toml
# format
node node_modules/prettier/bin-prettier.js --config app/.prettierrc.json --check packages/domain-roots/proposals/message-stamp-derivation
cargo fmt --manifest-path backend/cashweb/frank-cbor/proposals/message-stamp-derivation/Cargo.toml -- --check
# scope and whitespace: only the three allowed proposal directories
git diff --check
git diff --name-only d11773555cdfccf1bd811654da819176e4803baf
```

`run.cjs --emit` emits a candidate corpus to stdout for deliberate fixture
review; ordinary execution never rewrites it. Apply any reviewed byte changes
explicitly and run both checkers. Frozen-source hashes must not be silently
repinned. The Rust Cargo.toml/lock are confined to the opt-in proposal workspace;
no production manifest, dependency, build or API is changed. Tooling has no
production importers. Its local build output is ignored by the existing
repository target rule.

Requested lane: strong, tier 3. Actual execution: inherited session model
(no strong-lane TOML present); no claim of a named model override. Protocol and
security review and owner choice disposition remain outstanding at handoff.
