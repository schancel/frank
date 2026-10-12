# Experimental Solana public bindings

This is a pure, unallocated prerequisite. It adds no scheme allocation, protocol
capability, wallet signing authority, application installation or execution path.
Generic type-19/schema-2 readers retain scheme 2 as unknown public data. Scheme 1,
all generic framing limits, and all existing persistent/wire layouts stay unchanged.

Source contract: frozen Edwards proposal `4c96933a`, public crypto vectors
`e4b87c2d`, and closed transfer builder
`be85afe262f83aabd08945ce0791edfb985c0f7f`. Cryptographic acceptance and any later
scheme allocation require separate review. These fixtures do not claim an audit.

The optional existing opaque scheme-context byte string contains canonical CBOR
`[cryptoOperationId32, memberIndex:uint32, derivationContext32]`, at most 74 bytes.
Both 32-byte values are independently random and must be persisted before key
construction. Their randomness/persistence is the operation owner's obligation.
The journal operation UUID is distinct and does not replace either input. The
context never depends on ciphertext or its hash.

The opt-in experimental projection checks exact canonical Solana chain identity
against `docs/protocol/chains/v1.json`, scheme 2, recipient and ephemeral Ed25519
references of 32 bytes, native or classic SPL mint/program, a positive exact uint64
amount, destination32, transaction identifier64, required signed bytes1..16384,
and absence of UTXO vout. It copies public byte fields. It does not validate curve
points, signatures, instruction semantics, destination derivation, settlement or
configured mint decimals. Those checks remain with custody and financial owners.
There are no custody, transport or wallet dependencies.

The transcript helper reconstructs the frozen canonical array9:
`["frank:solana-stealth:edwards-add:v1", chainIdentifier, asset, recipient32,
ephemeral32, cryptoOperationId32, memberIndex, derivationContext32, amount:uint64]`,
where asset is `[0]` or `[1, mint32, classicTokenProgram32]`. Destination, raw signed
transaction, and decimals are validated separately and are not new Q inputs.

`experimental-solana-stealth.ts` generates
`experimental-solana-stealth-vectors.json`. The native transcript is independently pinned
to the frozen vector's public Q. The classic SPL case exercises uint64 and uint32
maxima; transaction bytes are synthetic structural placeholders, not receipt proof.
The Rust integration test reconstructs Q from its generic parsed payload and
checks byte agreement without adding an allocated-scheme parser.

From the repository root, regenerate and check:

```sh
FRANK_EMIT_EXPERIMENTAL_SOLANA_VECTORS=1 yarn --cwd packages/frank-codec test --runInBand test/experimental-solana-stealth.jest.test.ts
yarn --cwd packages/frank-codec test --runInBand test/experimental-solana-stealth.jest.test.ts
cargo test --manifest-path backend/cashweb/Cargo.toml -p frank-cbor --test experimental_solana_stealth
```

Do not hand-edit the JSON output. Tests compare it with its source generator and
require both the source and output in the review candidate.
