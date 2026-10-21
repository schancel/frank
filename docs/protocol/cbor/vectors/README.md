# Frank-CBOR test vectors

Every corpus in this directory, and the proposal corpora under `docs/protocol/proposals/`, is
the output of one command. Never edit a corpus by hand.

```sh
yarn vectors:generate   # rewrite every corpus (add --no-rust to skip the cargo step)
yarn vectors:check      # fail if any corpus differs from what its generator produces
```

Both run `packages/frank-codec/scripts/vectors.mts`. The `typecheck` workflow runs
`yarn vectors:check` on every push and pull request.

## What it runs, in order

1. `packages/frank-codec/scripts/vectors-renumber.mts` re-encodes the frozen corpora (listed in
   its `FROZEN_FILES`) for the type identifiers in `docs/protocol/message-types/v1.json`.
   `type-ids.json` records the identifiers they are encoded with. When the two agree the step
   is the identity, which is what `--check` verifies. Otherwise every frame's type is mapped,
   and every value derived from a type id is recomputed: T1/T1a/T3/T4 digests, the
   directory and key-transition signatures (re-signed with the committed test keys: scalars
   1–64 and the replacement scalars from `0x1001` used for signers with no committed secret),
   the direct-message crypto context and the suite-1 boxes sealed under it (resealed with
   ephemeral scalar 3 and the original salt and padding).
2. `packages/frank-codec/scripts/vectors-builders.ts` writes the corpora built from
   `packages/frank-codec/fixtures/` (`manifest.json`, `topic-commitments.json`,
   `stealth-assets.json`, `blackjack-hand*.json`, `forum-content-read.json`,
   `directory-preview.json`, the experimental Solana stealth vectors), and
   `packages/domain-roots/proposals/message-stamp-derivation/run.cjs --emit` writes that
   proposal's `vectors.json` (it pins hashes of its source files, so a source edit needs a
   regenerate).
3. The suite-1 directory and Forum proposal checkers rewrite their `vectors.json`; the suite-1
   proposal pins the hashes of the manifest, `README.md` and `directory.cddl`, so editing those
   files needs a regenerate. The suite-1 Rust checker
   (`backend/cashweb/frank-cbor/proposals/suite1-directory/check.rs --write`) then re-signs
   `rust-origin.json` with the Rust signer, whose nonces differ from noble's.
4. The builders run again (`directory-preview.json` reads the suite-1 proposal and
   `rust-origin.json`), `backend/cashweb/cashweb-registry/tests/directory_preview_corpus.cjs`
   writes `directory-admission.json`, and
   `backend/cashweb/cashweb-registry/tests/support/canonical_dm_plain_transfer_fixtures.cjs`
   re-signs the request fixtures in `monad_message_cbor_tests.rs` as plain transfers.
5. `cargo test` with `FRANK_UPDATE_RUST_VECTORS=1` and `FRANK_UPDATE_INTEROPERABILITY_VECTORS=1`
   rewrites `rust-origin.json` and `interoperability.json`.

Steps that need cargo run only when generating (`--no-rust` skips them). Under `--check`, the
TypeScript suite-1 checker verifies `rust-origin.json`, and `cargo test` compares the rest.

## Renumbering

Edit `id` in `docs/protocol/message-types/v1.json`, then run `yarn message-types:generate` and
`yarn vectors:generate`. Hex literals copied from vectors into test files are listed in
`FROZEN_FILES` and are rewritten with them.
