# Browser preview vault policy v1

This local storage policy implements the explicitly approved preview stage in
[#698](https://github.com/schancel/frank/issues/698). It allocates no network
protocol, recovery format or derivation purpose. It is not the full account
cutover or a production platform custody policy.

The supported claims are WebCrypto API non-exportability and separation from
ordinary serialized application state and ciphertext-record exports **that exclude
the dedicated key store**. Complete IndexedDB/profile theft, malicious same-origin
execution (including XSS), browser/OS compromise, hardware-backed custody, and
whole-store rollback resistance are explicitly outside these claims. A browser
may store the internal bytes of a software-backed non-extractable key in its
profile. This policy does not protect those bytes from a profile thief.

## Facade and ownership

`@frank/account-vault` accepts typed 32-byte purpose roots from the existing frozen
registry and bounded public `VaultContext` metadata. It never derives or accepts
an account root R, master M, Codex32 shares or mnemonic phrases. Validation cannot
detect a caller that falsely labels arbitrary bytes as a purpose root. It rejects
wrong registry/format, unknown/duplicate/out-of-order purposes, wrong root lengths,
shared buffers, invalid revisions and oversized metadata before storage effects.
It snapshots metadata and copies input roots synchronously before asynchronous
crypto. Returned roots have separate caller-owned buffers. Temporary plaintext
is zeroed best-effort on success and failure; JS engines and WebCrypto may retain
internal copies that this API cannot erase. There is no secret string/JSON
representation, telemetry, logging, networking or DOM use in runtime code.

Callers use `createVaultWriteIntent`, `openPreviewVault`, then `stage`, `open`,
`reconcile`, `remove`, `discardIntent` and `close`. Exported errors carry only these stable codes:

| Code | Meaning |
| --- | --- |
| `invalid-input` | Invalid public context, typed roots, receipt or intent |
| `unavailable` | WebCrypto/IDB absent, capability clone/reopen/decrypt failed, or database cannot open |
| `closed` | Facade closed before work/material publication |
| `locked` | No live material or missing non-extractable key |
| `corrupt` | Invalid stored structure/key, authentication failure or invalid plaintext framing |
| `conflict` | Expected receipt no longer matches, including duplicate stage/retry |
| `capacity` | Namespace has exhausted its bounded creation-slot inventory |
| `storage-failed` | Crypto preparation or transaction failed; no partial committed write |

No failure falls back to plaintext. Errors omit browser exception details and
root contents. `reconcile` returns `committed`, `absent`, `superseded` or `removed`;
it checks structural inventory and receipt identity, not ciphertext authentication.
Call `open` for authenticated material before activation/use.

## Persistent shape and atomicity

For namespace `[A-Za-z0-9_-]{1,64}`, the main database is
`frank-preview-vault-<namespace>`, IDB version 1. All three object stores use the
public creation ID as their out-of-line primary key:

| Store | Value |
| --- | --- |
| `records` | `{ receipt, iv: Uint8Array(12), ciphertext: Uint8Array }` |
| `keys` | `{ receipt, key: CryptoKey }`, non-extractable AES-256-GCM, encrypt/decrypt usages |
| `fences` | `{ revision, receipt }`; `remove` retains `{ revision, receipt: null }`; `discardIntent` retains `{ revision, receipt: null, discardedIntent }` |

Only WebCrypto structured clone persists keys; no raw/JWK export or raw-key import
path exists. Each preparation generates a fresh key and random 96-bit IV. Crypto
runs outside IDB transactions. The final readwrite transaction reads the complete
current inventory, checks the exact expected revision/context receipt, and writes
the matching ciphertext, key and fence together. Transactions request strict
durability. A reported transaction abort, failed clone or failed crypto leaves
the previous usable pair intact. This is not a guarantee against hardware loss
or a malicious browser.

Initial stage requires no existing fence. Replacement preserves account and
creation IDs, uses a distinct operation ID, increments revision by one, and
cannot decrease custody epoch. CAS serializes conflicting writers across facade
instances/tabs. Removal compares the exact receipt, deletes the exact key and
record atomically, and advances the fence by one. It can clean up a corrupted or
missing key/record when the authorizing fence still matches. A removed creation
ID cannot be staged again in that namespace. An in-flight old writer cannot
resurrect it. This is a **local staging fence**, not global account retirement:
a different creation ID can refer to the same account ID. #699 owns permission
for that identity transition. Corrupt authorization fences require coordinator
recovery; the facade does not guess which inventory may be deleted.

`discardIntent(intent: VaultWriteIntent): Promise<void>` cancels a known pending
write without receiving roots or performing crypto. It snapshots and validates
the complete intent before asynchronous storage work. One strict readwrite
transaction may either reserve an entirely absent slot for an initial
`expected: null` intent, or delete the key/record authorized by the intent's exact
live receipt. An absent replacement, superseded/foreign live receipt, or legacy
tombstone without exact discard evidence rejects with `conflict`. Missing or
malformed authorization and orphan material reject with `corrupt` without
deleting inventory. An exact live fence can authorize cleanup of missing or
damaged material, as with `remove`. The operation never deletes another slot.

The additive `discardedIntent` field is the canonical bounded public
`{ expected: VaultReceipt | null, receipt: VaultReceipt }` snapshot. Both receipts
retain the existing validated receipt/context shape; no keys or root material
are retained. The expected receipt is necessary to distinguish retries with a
different predecessor even if they name the same output receipt. The fence's
`revision` is always `discardedIntent.receipt.revision + 1`, including cancellation
before initial stage (`revision: 2`). Exact retries compare both receipts, consume
no additional capacity, and succeed across database and browser restart. A
different operation, context or predecessor cannot claim another discard's
success. A malformed discard field, wrong fence revision or discard evidence on
a live fence is corrupt. Legacy live and removed rows retain their meaning;
`remove` retains its existing behavior and does not erase discard evidence.

This optional local field needs no IDB version change or migration. Existing
readers still recognize the null receipt as a permanent fence. Prepared initial
and replacement stages fail their existing CAS after a successful discard.
Absent cancellation consumes one of the same 1,024 slots; exact retry and live
cleanup consume none. Transaction aborts and storage failures roll back all
deletions and the fence write. A closed facade rejects new discard calls. Like
existing removal, a transaction already submitted before close may finish;
completion is acknowledged only after transaction commit.

Readers take a coherent key/record/fence snapshot and recheck the receipt after
decryption before publishing all roots together. This provides an operation
linearization point, not revocation of plaintext already returned to a caller.

There are at most 1,024 creation slots including retained fences per namespace;
replacement does not consume another slot. A slot has at most five roots, a
167-byte plaintext and a 183-byte ciphertext including its 128-bit tag. Public
strings contain at most 128 printable ASCII characters. All strings are nonempty
except retirement context, which may be empty. Revisions/epochs are bounded to
`0..0xfffffffe` (live revision at least one); removal can produce `0xffffffff`.
No automatic fence eviction or namespace rollover exists. Capacity requires an
explicit coordinator decision, preserving unresolved activation evidence. IDB
must materialize a stored row before its bounded schema can be checked; the
package rejects oversized rows before passing them to crypto.

## Local authenticated encoding

Receipt schema is `1`, policy is `browser-preview-aes-gcm-v1`. AES-GCM uses a
128-bit tag. Its additional authenticated data is the following fixed sequence.
`text` means a u16 big-endian byte length followed by printable ASCII bytes;
numbers are u32 big-endian except the purpose count, which is a single byte:

1. text `frank/local-vault`, schema, policy text.
2. account ID, creation ID, recovery format, registry (each text).
3. purpose count, then each exact ordered purpose text.
4. custody epoch, previous revision, current revision.
5. recovery fingerprint, retirement context, operation ID (each text).

Recovery format is `codex32-master-v1`; registry is `frank-domain-roots-v1`.
Purposes form a nonempty ordered subset of the frozen registry order.
Plaintext is byte `1`, one-byte purpose count, then for each purpose a one-byte
registry code (`1..5` in frozen registry order) and exactly 32 root bytes.
Plaintext length, version, count and every code must match before any roots are
returned. Every field in the receipt is authenticated; IV/ciphertext/tag changes
fail authentication. This encoding is private local storage, not a wire format.

## Capability and process restart

Every facade open generates a non-extractable test key and encrypts the public
three-byte marker `46 56 01`. It structured-clones the key/IV/ciphertext into the
single `capability` row of the separate IDB v1 database
`frank-preview-vault-<namespace>.capability`, store `probe`. It closes that database,
opens it afresh, validates the key/record bounds, and decrypts the marker. This
bounded single-row probe contains no account material and concurrent probes may
replace it. The probe database remains for reuse; deleting account material does
not delete this unrelated public test fixture. All connections close on failure
or explicit facade close; version changes close stale connections.

This runtime probe is complemented by the real browser integration test: create
and commit, terminate Chrome, start a new Chrome process with the same temporary
profile/origin, and decrypt the same roots. The test checks non-extractability and
raw/JWK export rejection before and after restart. It also inspects ordinary
serialized application/record exports; that is expressly not a profile-theft
security proof. A supported result applies only to the tested browser/platform.
Electron, Capacitor, Safari and Firefox require their own equivalent evidence;
support is not inferred from a shared browser engine.

Implementation evidence on 2026-10-03: installed Chrome `154.0.8037.97` on macOS
passed a complete process-close/profile-reopen roundtrip and non-extractability
checks in both processes. This is the only platform/version support evidence
recorded by this change; rerun the harness for other environments.

## Account activation, retry and rollback boundary

[#699](https://github.com/schancel/frank/issues/699) owns authoritative account and
identity indexes, durable creation IDs, account activation/rollback, retirement,
and tombstones. It must persist the public write intent with its pending account
creation **before** staging. A successful `stage` creates only a wrapped-material
receipt; it never means `setupState=complete` and never authorizes networking.
Before account use, #699 reconciles its intent, opens authenticated roots, and
atomically activates the account referencing the receipt. Failed activation
leaves a known staged orphan; #699 must reconcile/remove that exact receipt.
The vault intentionally provides no parallel account directory or identity index.

If a response is lost after commit, the saved intent gives the exact receipt to
reconcile. `committed` means continue the existing attempt after authenticated
open; `absent` allows retrying the same intent; `superseded`/`removed` requires
coordinator reconciliation. Duplicate `stage` conflicts without changing stored
material. Never create random new account/creation IDs on an ambiguous retry.
Cleanup's lost response is resolved by repeat removal for the legacy removal
path. `removed` alone does not prove which intent performed a discard.

For cancellation, [#732](https://github.com/schancel/frank/issues/732) persists the
pending intent before stage and calls `discardIntent` before clearing that
pending state. Success durably fences even an initial stage still preparing
crypto, so a cancelled absent attempt need not lock setup forever. A lost discard
acknowledgement is resolved by retrying the exact saved intent; rejection requires
coordinator reconciliation. The caller owns authorization to cancel and must
never discard its active account. The vault does not inspect account activation
state or provide a second account directory.

Rollback preserves encrypted records, fences and pending activation evidence.
It must not delete a namespace or substitute plaintext storage to recover from
an unsupported platform. Stronger platform/passkey custody is separately owned
by [#717](https://github.com/schancel/frank/issues/717). A later local-schema/policy
replacement requires an explicit reviewed migration; this package provides no
speculative adapter framework. The stable receipt and creation ID leave #699's
account coordination seam intact.
