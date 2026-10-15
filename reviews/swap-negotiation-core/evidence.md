# S5a pure negotiation candidate evidence

Exact base: `3951bbf2557a31d7380a3ae6b07431f966e031b5`. Root-authored Tier-3 contract: [contract.md](contract.md), including approved registry/admission/schema-decoder clarifications. Requested/dispatched lane: GPT-6.1 Sol medium. This candidate is prepared for independent exact-tip review; no release hold is lifted.

## Implemented boundary

The separate `src/negotiation.ts` entry owns frozen canonical offer/accept/reject payloads, identity authorization, explicit pair policy, full expected-context binding, deterministic reduction and explicit-clock eligibility. Existing transcript/Stage-0/pair source and package main exports are unchanged. Cashweb, wallet, codec, registry source, UI and host composition are unchanged. No plugin is installed or financial operation performed.

Offer/response bytes, role/sequence/prerequisite restrictions, identity-key and terms-hash domains follow the contract. Amount APIs use bigint, XEC uint64 and fixed big-endian EVM uint256. The real existing `MonadIdentity.signHash` signer interoperates with central algorithm1 strict-DER low-S verification over SHA256 of the existing event-signature preimage exactly once. Injected asynchronous signer output is verified, and mutable builder inputs are snapshotted before awaiting it. Golden vectors pin identity key ID, payload, terms hash, signature digest and complete canonical event bytes, including an amount beyond JavaScript's safe integer range.

The explicit testnet and regtest-proof policies use distinct canonical identifiers. A direct import of authoritative `docs/protocol/chains/v1.json` checks exact IDs, family and JSON-RPC permission. No protocol fact is duplicated in a consumer registry and no numeric ID or alias selects a network. This structural check does not verify an upstream node or its checkpoint. Base TypeScript settings already supported JSON imports; no tsconfig change was needed.

Stateless consumers use `decodeNegotiationEventSchema(bytes, explicitPolicy, enclosingBudget)`: it validates schema, self-contained signer, role/sequence/prerequisites, key ID and signature without inventing an absent A key for an orphan response. Its result has no operation-admission authority. Full-context decoding separately binds swap/conversation/ordered parties using the same single payload parse and budget. The host validation helper additionally checks supplied canonical sender/recipient keys, local key, actual conversation and explicitly named incoming/outbound direction. It checks caller assertions, not their provenance.

Every event is fully prevalidated before the existing core reducer, including malformed or context-mismatched orphans. Admission rejects more than64 inputs,1024 bytes per event,65536 total bytes or512 payload bytes before signature verification; duplicates count. Missing valid offers buffer responses. Duplicates/reordering, wrong actual terms and conflicting sender decisions/offers are covered. `usableAcceptance` is null on every violation. Historical acceptance survives expiry; an explicit current Unix-seconds clock gates preparation with strict `now < expiry`. Neither acceptance nor eligibility authorizes funding, release, deletion or cancellation of financial recovery.

## Final verification

| Gate | Result |
| --- | --- |
| Entire swap-protocol suite | 4 suites,43/43 pass |
| Existing codec registration/signature, CBOR and stage tests | 3 suites,97/97 pass |
| All configured `yarn typecheck:fast` projects | 23/23 pass |
| Whole swap-protocol app-configured Prettier check | Pass |
| Existing justified-dependency checker against swap package | Pass,2 runtime dependencies |
| Focused production-import whitelist regression | Pass in negotiation suite |
| Existing core/wallet/codec/registry source comparison against exact base | No changes |
| `git diff --check` | Pass |

Commands:

```sh
yarn --cwd packages/swap-protocol test --runInBand
yarn --cwd packages/frank-codec test --runInBand test/registration.jest.test.ts test/cbor.jest.test.ts test/stages.jest.test.ts
yarn typecheck:fast
(cd packages/swap-protocol && ../../node_modules/.bin/prettier --config ../../app/.prettierrc.json --check .)
node packages/nakamoto/scripts/check-deps.mjs --root packages/swap-protocol
git diff --check
```

Logs: `/tmp/frank-s5a-tests-final.log`, `/tmp/frank-s5a-codec.log`, `/tmp/frank-s5a-typecheck-final.log`, `/tmp/frank-s5a-format-check.log`, `/tmp/frank-s5a-deps.log`.

Coverage includes positive accept/reject, real identity signing, canonical core encoder/decoder/reducer integration, altered fields/signatures/hashes, unknown fields, invalid points, noncanonical CBOR/float/byte forms, zero/overflow amounts, exact party counts, extra prerequisites/later sequences, malformed orphans, authenticated context rejection, asynchronous input mutation, expiry equality/replay, and actual inherited codec counter exhaustion. Tests verify schema-only and full-context decoding each charge exactly one payload parse. Runtime ownership remains pure: the only production imports are codec primitives, hash primitives, authoritative chain JSON and existing swap core, enforced by a focused test. The real wallet signer import is test-only.

Package metadata now declares the already-present `@frank/codec` workspace dependency; Jest mappings allow the existing real signer fixture. The existing checker documents that Yarn1 does not add workspace-owned dependency maps as lockfile keys. No install/download or lockfile modification was needed. Candidate-local external dependency overlays use only installed packages; every @frank link targets this checkout, wallet Chronik4.3.1 was verified. Per coordinator request, these ignored overlays are retained for later integration verification, with no test process left running.

## Remaining scope

No persistence schema/migration, threshold session, native-chain test, funded execution, deployment, push or merge was performed. S5b still owns the application carrier plugin and authenticated host installation, and later runtime/UI/execution work retains all custody, financial recovery and cryptographic-assurance gates. A schema-valid item alone must not drive runtime state effects. The new wire has no production writers yet; coordinated feature reader/writer updates are required once installed.

## S5a-1 repair after independent review

Independent reviewer and verifier confirmed that initial candidate `9274824fba23d78f1e3aaf0f2ac83659f421d2ca` did not meet the snapshot contract for Node Buffer inputs: `Buffer.slice()` aliases rather than copies. The initial43-test result above did not cover that subtype and does not establish Buffer ownership. Deferred real-signer traces changed an offer swap ID and a response prerequisite after the digest had been signed, while the builder still returned `ok`. The receiving verifier rejected those invalid signatures; no forged acceptance or financial effect was demonstrated.

The repair normalizes accepted byte inputs into owned plain `Uint8Array` instances. It snapshots context fields, response offer bytes before decoding, schema-decoder input before the unchanged core takes slices, and the external signer's input/output. Auditing the same decoder boundary also found that core reduction retained Buffer-backed applied-history fields; the wrapper now owns the admitted batch before prevalidation and core reduction. The existing transcript core, schemas, domains, limits, exported API, dependencies and golden wire bytes are unchanged.

Five new real-Buffer regressions cover both deferred-signing reproductions, all response context fields plus the returned Buffer signature, schema-decoder ownership, and reducer applied-history ownership. The two original reproductions failed on the unmodified candidate and passed after repair. The reducer-history regression separately failed before owning the admitted batch, then passed in the final full suite.

| Repair verification | Result |
| --- | --- |
| Exact two deferred-signing regressions, fail before | 2/2 fail as expected |
| Same two regressions, pass after | 2/2 pass |
| Buffer reducer-history regression, fail before batch copy | Fails as expected |
| Final entire swap-protocol suite | 4 suites,48/48 pass |
| Codec signature/canonical/stage suites repeated during repair | 3 suites,97/97 pass |
| Final all configured typechecks | 23/23 pass |
| Whole swap-protocol formatting and existing dependency checker | Pass |
| `git diff --check` | Pass |

Reproduction:

```sh
yarn --cwd packages/swap-protocol test --runInBand src/negotiation.jest.test.ts -t 'Buffer ownership'
yarn --cwd packages/swap-protocol test --runInBand src/negotiation.jest.test.ts -t 'reduction owns Buffer'
yarn --cwd packages/swap-protocol test --runInBand
yarn typecheck:fast
```

Logs: `/tmp/frank-s5a-buffer-before.log`, `/tmp/frank-s5a-buffer-after-exact.log`, `/tmp/frank-s5a-buffer-history-before.log`, `/tmp/frank-s5a-buffer-full.log`, `/tmp/frank-s5a-buffer-typecheck.log`, `/tmp/frank-s5a-buffer-codec.log`, `/tmp/frank-s5a-buffer-format.log`, `/tmp/frank-s5a-buffer-deps.log`. The same optional overlays remain retained for integration. This repair requires fresh independent exact-tip review and does not complete S5b transport, host admission, UI, or financial execution.
