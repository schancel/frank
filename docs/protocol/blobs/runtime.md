# Transparent attachment runtime (#1571)

## Ownership and scope

The accepted baseline already defines `BlobManifest` and XChaCha20 chunk encryption
in `packages/cashweb/blobs/payload-splitter.ts`, and persists content-addressed
ciphertext in the Rust relay's `blobs-v1` sidecar. This change installs those helpers
in the existing canonical messaging workflow, which is currently colocated at
`packages/wallet/chain/monad-canonical-dm.ts`. Both app and headless hosts use this
workflow. Relocating it, changing custody, group delivery, new crypto protocols,
quota/billing policy and a new storage framework are outside this change.

The app's existing image compression and composer size policy are unchanged. Normal
app images above 32 KiB use the installed splitter. The greater-than-1-MiB regression
uses the shared installed email-attachment/headless path; it does not claim the app
composer accepts arbitrary files of that size.

Messaging owns preparation, encryption and delivery; custody continues to own keys
and signing. Dependencies remain messaging → cashweb transport/helpers and messaging
→ the existing narrow custody/payment capabilities. Cashweb payload helpers do not
import custody implementations or application stores.

## Persistent and wire shape

The durable shape is unchanged. `OutgoingMessageStore` remains the sole owner of
exact sealed envelope bytes, payment transactions, exposure authorization and
submission outcomes. Wallet inventories retain exclusive reservations. Relay
`BlobStore` owns uploaded ciphertext chunks. The encrypted manifest in the envelope
is the only durable association between that message and its chunks; neither a
second plaintext journal nor a competing reservation store is introduced.

New messages split images and email attachment payloads strictly above 32,768 bytes
using the existing 262,144-byte plaintext chunks. The established helper's attachment
handling remains available. The existing canonical item codec validates the prepared
items before sealing/payment. Blob keys, nonces, metadata and hashes travel inside
the sealed manifest, never as plaintext envelope metadata. This changes which
existing wire item is emitted, not the manifest version or key derivation.

Uploads complete before sealing and payment reservation. An interrupted upload has
no signed payment or financial journal entry; uploaded ciphertext may remain in the
relay store. A repeat after that interruption may prepare fresh chunks. Once an
exact envelope is durable, both paid and named unpaid repeats reuse that envelope
without splitting again. Existing restart reconciliation submits its original signed
transaction set; it never authorizes a replacement payment. Reversal of installation
is local code, but already sent manifests must remain readable. No migration, dual
writer, local data reset or private key deletion is required or authorized.

## Receive and failure behavior

Every fetch uses the messaging owner's stable installed Home Relay origin. An origin
hint is only a query parameter to that relay; it is never the browser destination.
Requests omit credentials and reject redirects. The client bounds each ciphertext
response stream to the relay's existing 512 KiB maximum, times out the request,
cancels the reader and verifies length/hash/authentication through the existing
reassembly helper. The Rust proxy's DNS/SSRF, hash and bounded upstream rules remain
unchanged.

Before any upload or fetch, the shared helper admits the whole message against
`MAX_MESSAGE_PAYLOAD_PLAINTEXT_BYTES` (100 MiB) and
`MAX_MESSAGE_PAYLOAD_CHUNKS` (4,096). It counts manifest declarations and materialized
inline/split image and attachment payloads together; empty companion placeholders
count zero. Repeated descriptors count separately because each would retain another
output or perform another decryption. Safe integer checks and subtraction bounds
reject invalid/oversized totals before adding them. This preserves a single valid
100 MiB attachment without allowing many such manifests to amplify one message.

`PayloadBudgetExceededError` is permanent. The local writer rejects it before blob
uploads, sealing, payment claims or journal writes. Receive hydration propagates it
without wrapping it as a transient failure; polling quarantines the authenticated
message timestamp/digest using the existing host quarantine path and continues later
records. The stream reports the typed rejection and can deliver later records.
Existing durable sender envelopes/payments remain owned by their original journals
and continue exact replay; rejection never deletes or replaces them.
A headless caller that omits the quarantine callback may structurally rescan a
poison-only mailbox, as with existing malformed frames; it performs no blob I/O or
chunk decryption for the rejected declarations and still processes later valid messages.
No rejection cache or new persistence owner is introduced.

A missing or tampered chunk fails the entire `fetchSince` pass with
`CanonicalPayloadUnavailableError`; it does not acknowledge the message or return a
partial successful batch. A later poll retries the same sealed message. Unsupported
manifest plugin data retains the existing `unsupported` item behavior and is never
fetched or executed. Successful reassembly removes companion manifests and restores
attachment slots before any message reaches the host.

Mailbox stream delivery permits one asynchronous record at a time. Overlap or a
payload failure yields the subscription to polling for the rest of its lifetime,
without buffering an unbounded queue or letting later stream records advance past a
skipped record. Recreating the subscription restores streaming. Closing a subscription
suppresses an in-flight hydrated record. Polling remains the durable recovery owner.

## Acceptance commands

```sh
yarn --cwd packages/cashweb test --runInBand
yarn --cwd packages/wallet test --runInBand chain/payload-runtime.jest.test.ts chain/monad-canonical-dm-message-id.jest.test.ts
yarn --cwd app test:unit:ci --runInBand src/adapters/pinia-chain-adapter.outgoing.jest.test.ts src/adapters/pinia-chain-adapter.reload.jest.test.ts
yarn --cwd packages/bot test --ci --runInBand qwen-bot-common.jest.test.ts bot-entry-import.jest.test.ts
yarn typecheck:fast
cargo test --manifest-path backend/cashweb/Cargo.toml -p cashweb-registry --lib http::blobs::tests
cargo test --manifest-path backend/cashweb/Cargo.toml -p cashweb-registry --lib installed_payload_runtime_two_rust_routers -- --ignored --nocapture
```

The explicit Rust integration command launches two actual Rust HTTP routers and
runs the installed wallet send/receive regression with their origins. It transfers
an attachment larger than 1 MiB, uploads five encrypted chunks to the sender, fetches
through the recipient's Home Relay proxy, and checks restored plaintext. The same
test interrupts after journal durability and verifies exact envelope/payment replay
after a real Level close/reopen. Custody, canonical sealing/opening and journals are
real; chain RPC/finality and canonical mailbox HTTP use the existing offline fixture.
This is not evidence of live-chain settlement. The ordinary Rust blob tests also
verify cache hits after origin failure, upstream tampering rejection and SSRF bounds.
