# Experimental Solana payment owner

This uncomposed successor supports native SOL and classic SPL, received-descriptor import and respend, and gathering from independent source accounts. It is absent from wallet/app exports and does not enable a chain capability. Crypto/protocol acceptance remains separate. Custody predecessors are sender `98084a6d`, explicit ATA rent `4cbd3e46`, and closed restored-recipient signing `12fae3de`. The Edwards proposal and independent vectors remain experimental.

## Ownership and persistence

`SolanaPaymentState` owns public positions, reservations, immutable operation intent, the unsigned random contexts and destination, original signed transaction set, envelope digest, and finalized outcomes. The single `format:3` snapshot also retains account retirement slots: repeated old receipt/sync observations cannot resurrect spent positions. No seed, scalar, nonce prefix, or encrypted message is persisted here. Generic messaging alone owns its encrypted envelope. Trusted composition invokes `expose(operationId,{payloadDigest})` only after its generic `onEnvelopeDurable` callback. The digest never participates in key derivation.

`IndexedDbSolanaPaymentPersistence` owns atomic strict-durability read/modify/write transactions across handles and tabs. A read-only open of an absent namespace aborts creation. The first authorized mutation initializes it. Missing state is inspectable without writing defaults; unsupported, corrupt, or foreign state rejects without reset. No old-format reader or migration exists, including the experimental format-1 and format-2 predecessors. For an unfunded disposable development environment, the host may explicitly choose a fresh namespace; there is no implicit deletion or reset of funded state.

Quotes persist external operation UUID, distinct random `cryptoOperationId32` and `derivationContext32`, canonical chain, full asset, amount and native debit/fee ceilings **before** custody derivation. They reserve nothing. The WASM adapter deterministically reproduces each public destination after reopen using the separate experimental sender-nonce predecessor. The private scalar remains inside WASM. Classic token decimals are signing metadata; they do not change the frozen Edwards transcript.

The unsigned quote freezes member allocations summing the intended amount, using available public inventory without reserving it. Each member has its own persisted contexts and destination. The protocol maximum is `MAX_PAYMENT_MEMBERS` (64); a constructor may choose a stricter operational limit. Failure to fulfill the full amount, member bound or total fee/rent authorization rejects rather than creating a partial payment. Exact per-transfer ceilings are separate from total maximum fees, total maximum rent and total native debit. Native debit includes principal; SPL debit excludes the transferred tokens.

Prepare reserves the complete current source set in one short atomic transaction. It may choose another sufficient unreserved source for an unchanged member allocation, within the same approved asset/budget. Each member has an independent source owner and transaction. Network/custody work takes no inventory lock. SPL reserves its ATA and same-owner native fee account; no consolidation, separate fee payer or extra native subsidy is constructed. ATA creation requires explicit intent authorization, a durable exact rent quote within both per-transfer and total ceilings, and a fresh matching rent observation before signing. The backend emits only fixed idempotent classic ATA creation, TransferChecked and memo. Token2022/arbitrary token extensions remain unsupported.

`primary` and `received` signing references are public tagged records. Received references retain full original B/R, chain/asset, crypto operation/context bytes, member index, original receipt amount and P. Import first asks WASM to validate seed/B affinity and the full original transcript/P, then verifies actual finalized chain effects. Repeated receipt import cannot overwrite a reservation, newer observation or consumed account. Custody resolves the private recipient scalar/prefix lazily inside WASM for a separately bound new outgoing descriptor. Original receipt amount is not treated as current balance. Token receipts retain an explicit `needs-native-gas` prerequisite until an owned native account balance is observed; the sender does not fund it implicitly.

The engine verifies canonical RPC genesis identity from the protocol registry, exact one-transfer transaction policy, standard Ed25519 signature, actual message fee against authorization, and complete original-set atomic persistence before returning bytes. The closed WASM backend owns the exact cryptographic transcript and authorization memo digest; the engine checks the memo program, structure and absence of extra instructions. The injected RPC adapter must faithfully implement initialized-token-account validation, fee lookup and **finalized** evidence semantics. No permissive generic RPC result is silently treated as those facts.

An unsigned interrupted reservation can be explicitly released while retaining contexts/destination. Signed or exposed attempts cannot be released through that path. Submit requires durable envelope binding and rebroadcasts the original bytes. Unknown status, timeout, blockhash expiry or UI discard do not release claims or create a replacement. Finalized execution evidence retires only that member’s source observations. Actual post-transaction source balances are installed atomically with `postSpendSignature` at the finalized slot; the retirement watermark still rejects older/equal receipt replay. Zero balances retire completely. Repeated finality cannot retire a newer observation or release another member. Partial receipt sums include only members with matching successful finalized effects; unknown submissions remain reserved. Failed transactions require consistent finalized error metadata and source balances.

Receipt verification reads successful finalized original bytes and exact native/token recipient balance effects. The verifier itself does not mutate state or rebroadcast. The engine’s `recordIncomingClaim` validates the original signature, fixed instructions and closed recipient custody affinity, then durably retains the authenticated claim with its payload digest before any RPC call. `reconcileIncoming` credits inventory only after matching canonical finalized evidence, atomically with the retained claim outcome. Token receipts explicitly require an owned native balance observation before spending.

## Checks

From the repository root, with the matching workspace dependencies:

```sh
yarn typecheck:fast
node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/solana-contact-payments/operations.jest.test.ts
```

Build the experimental WASM using the commands beside `../solana-crypto-backend/build-wasm.sh`, then run:

```sh
node packages/wallet/solana-contact-payments/browser-test.mjs
```

The browser harness bundles `browser-entry.ts` with esbuild, starts disposable Chrome on loopback, and uses actual WASM and strict IndexedDB. All keys are synthetic and RPC responses are simulated. It proves receipt import, custody close/reopen, independent native gathering, partial settlement, exact original retries, residual balances, replay rejection, explicit SPL ATA rent and native-gas requirements, and actual received-SPL respend. It makes no live settlement or externally audited crypto claim. Profiles and a public synthetic signed-member manifest are retained in the system temporary directory. Unit tests additionally cover independent storage handles, concurrent whole-set selection, unrelated-account progress during signing waits, partial success/failure restart, atomic original-set failure, corrupt restoration and forged native/token receipt evidence.

Run the separate exact canonical-wire size proof against the printed public manifest and the frozen reviewed codec tree:

```sh
node --import tsx packages/wallet/solana-contact-payments/wire-size-proof.mjs /absolute/path/owner-signed-members.json /absolute/path/to/experimental-solana-wire-helper
```

The external artifact must have HEAD `e5694dbba5791d6757618e0bcacf27cfd81ea004`; the harness checks it and imports its public codec/helpers without adding a production dependency. It projects actual owner signatures, then encodes a structural worst case: 64 maximum 1232-byte SPL transactions, split into **four type-19 items of 16** (the existing per-item schema limit), 1024-byte memo per item, maximum 262144-byte text, maximum crypto padding and one maximum-size 16 KiB stamp. Exact type-6 plaintext is 368730 bytes; ciphertext 434285 bytes is below the codec’s 524288-byte limit; encoded crypto box is 434371 bytes; paid type-1 delivery is 451570 bytes. Hex encoding plus existing relay framing headroom is 1035236 bytes, below the actual 2097152-byte relay cap. The worst-case raw/ciphertext arrays are sizing fixtures, not executable payment or encryption proof. Arbitrary additional plugin items or multiple maximum-size stamps still require host canonical preflight.

## Required successors

Real canonical RPC composition, authenticated profile publication, generic messaging/wire composition with grouping and whole-message preflight, and independent integration/crypto acceptance remain required. No app/UI or protocol capability is enabled. Signed but unexposed originals remain protected from the unsigned release path; an authorized cancellation/recovery policy is separate from exposure or uncertain-chain release. No all-asset production completion is claimed.

## Concrete RPC predecessor contract

The successor adapter owns only projection of explicitly injected Solana JSON-RPC results into the financial owner's narrow RPC contract. It has no inventory, key, message, endpoint-default or planning ownership. Before each financial read or submission it verifies the canonical chain's registry genesis hash. It requests finalized transaction bytes and metadata, exact history signature status, classic initialized mint/account records, fee and plain 165-byte token-account rent. Native RPC numeric quantities must be safe nonnegative integers; unsafe JS numbers fail visibly rather than becoming rounded money. Token amounts remain canonical decimal u64 strings. Token2022, malformed account layouts, ambiguous finality, signature/byte mismatches, unsupported transaction versions and inconsistent metadata reject. Missing/unknown transactions remain null, preserving original reservations and recovery.

This predecessor adds no persistent or wire format and removes no API. Its only submit path forwards the caller's original bytes as base64. Source and recorded-shape fixture tests cover wrong genesis, unsafe amounts, malformed classic accounts, partial/missing finality, exact original submission and finalized metadata projection; owner interruption/reopen tests remain the ac0e4aa9 acceptance boundary. No live RPC or funded account is accessed by these checks.

RPC adapter checks:

```sh
node_modules/.bin/jest --config packages/wallet/jest.config.js --runInBand packages/wallet/solana-contact-payments/rpc-adapter.jest.test.ts packages/wallet/solana-contact-payments/operations.jest.test.ts
```

These include the concrete adapter through original submission timeout, state/adapter reopen, pending reservation retention, exact rebroadcast and finalized residual installation. The HTTP transport requires an explicit endpoint and fetch implementation, validates JSON-RPC IDs/errors, and uses no default endpoint. Financial account reads additionally reject delegate, close-authority, frozen or native-wrapped token accounts. Because ordinary JSON parsing cannot preserve unsafe numeric literals, numeric lamport fields above `Number.MAX_SAFE_INTEGER` fail visibly; they are not rounded or silently coerced. This is an explicit adapter limitation, while token decimal u64 strings remain exact through the full range. The transport is still an RPC trust boundary, not independent consensus verification.

RPC response semantics follow the official [getTransaction](https://solana.com/docs/rpc/http/gettransaction), [getSignatureStatuses](https://solana.com/docs/rpc/http/getsignaturestatuses), and [JSON structures](https://solana.com/docs/rpc/json-structures) documentation. Fixtures use these shapes with synthetic keys and bytes; they are not represented as captured live financial evidence.


## Incoming original evidence contract (format 3)

The existing `SolanaPaymentState` remains the sole owner of incoming evidence and available positions. New `incoming[signature]` records retain the complete original transaction, full public descriptor context/asset/destination/amount, authenticated payload digest and pending/confirmed/failed status. No competing coin store, encrypted envelope or messaging dependency is introduced. Format 3 deliberately rejects earlier experimental snapshots; no migration, reset or key deletion is performed. Read-only restoration verifies original signature and fixed transaction policy but does not initialize custody or contact RPC.

Trusted authenticated mailbox composition calls `recordIncomingClaim(claim,{payloadDigest})` and awaits durability before advancing its frontier. The digest is a host authentication/exposure fact, not a key-derivation input or a wallet assertion of transport authentication. Ingestion performs pure exact original validation and closed WASM recipient-affinity validation without RPC, and creates no spendable funds. Repeating the original is idempotent; changes to context, asset, amount, original bytes or digest reject. Offline and unknown status remain pending. `rebroadcastIncoming(signature)` validates restored custody affinity and sends only the retained original bytes, without signing, replacement, subsidy or expiry-based discard.

`reconcileIncoming(signature)` requires canonical chain identity and matching finalized status, exact original bytes and metadata. Failed execution remains retained with no inventory credit. Successful actual recipient effects and public custody reference enter inventory in the same atomic state commit as claim finality. Existing retirement watermarks and newer/reserved positions remain authoritative; repeated finalized claims do not re-import or resurrect funds. The stored `credit` is the historical import disposition, not a claim that a subsequently spent balance remains available. `incomingProgress(signatures)` reports separate intended and verified received sums for a bounded same-asset member set, including partial outcomes. No caller may infer full receipt from message arrival.

The old finality-first `recordReceipt`/standalone `importReceived` path is removed in this coherent experimental baseline. Acceptance includes offline strict-IndexedDB persistence, custody close/reopen, original-only recipient retry, finalized atomic credit, failure/partial reporting, malformed and cross-chain rejection before durable rows, and receipt replay after spend retirement. Generic mailbox activation and protocol allocation remain gated separately.
