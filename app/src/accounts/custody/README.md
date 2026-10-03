# Local account custody

Import only `app/src/accounts/custody/index.ts`. This app-owned facade coordinates
the public account record with `@frank/account-vault`; it does not complete a
signup ceremony, derive keys, publish a profile, fund a wallet, or start a session.
The immediate consumer is [#699](https://github.com/schancel/frank/issues/699).
Legacy stores, mnemonics, and existing startup behavior are untouched by this stage.

```ts
import { openAccountCustody } from './accounts/custody'
import { DOMAIN_PURPOSES } from '@frank/domain-roots'

const custody = await openAccountCustody({ namespace: 'local-account-v1' })
const before = await custody.snapshot()
const expectedActive = {
  revision: before.revision,
  accountId: before.active?.receipt.context.accountId ?? null,
}
// confirmed is the result of confirmWithMetadata / descriptor-pinned recover.
// Allocate these public IDs once per explicit user attempt and retain them on retry.
await custody.stage({
  attemptId,
  accountId,
  expectedActive,
  displayName,
  custodyEpoch: 1,
  metadata: confirmed.metadata,
  roots: DOMAIN_PURPOSES.map(purpose => confirmed.roots[purpose]),
})
// Success above means only staged material. Activation is a separate user decision.
await custody.activate(attemptId, expectedActive)
const capability = await custody.openActive()
const ownedRoots = capability.takeRoots() // transfer exactly once; never store in Pinia
try {
  // Supply these transient typed roots to the future session adapter.
} finally {
  ownedRoots.forEach(root => root.bytes.fill(0))
  capability.close()
  custody.close()
}
```

Caller roots and metadata must come from a confirmed/recovered ceremony. The facade
cannot establish that arbitrary 32-byte values were honestly labelled as domain
roots, or establish the trust provenance of public metadata. It copies caller
roots synchronously before its first await, captures each metadata property once,
and erases its temporary copies on all completion paths. Callers own and erase
their original input. A retry of committed material authenticates and compares
the input roots against the stored roots. An incomplete intent requires the same
confirmed input; callers must not generate fresh identities to evade ambiguity.

`openActive()` returns roots held in a closure, outside enumerable/JSON state.
`takeRoots()` transfers those owned buffers once. Capability or facade `close()`
erases roots not yet taken. Already transferred roots belong to the caller;
closing or replacing the account cannot revoke copies already handed out. JS and
WebCrypto may retain engine-owned copies, so erasure is best effort.

## Durable state and transitions

The dedicated IDB database `frank-account-custody-<namespace>`, version 1, has one
store `state`, key `account`. Its row contains `{schema: 1, revision, active,
pending}`. Missing state means no account; malformed state never does. Revision
counts only successful activations. There is one active account and at most one
pending staging/cleanup attempt. Every transition uses a strict-durability IDB
readwrite transaction, including its precondition checks; there is no JS mutex.

Each public account explicitly projects the validated display name (1–80 UTF-16
code units, trimmed, no control characters), canonical #728 descriptor and
fingerprint, public retirement and identity commitments, and the exact vault
receipt. Account and attempt IDs contain 1–128 ASCII letters, digits, `_` or `-`.
Purposes, format, registry, epoch and IDs live in the receipt context. Public
commitments encoded as hex are byte representations, not new cryptographic codecs.
The descriptor and fingerprint use the existing account-recovery codecs only.

Every attempt owns a fresh creation slot named by its stable attempt ID. Schema 1
uses only initial vault intents: `{expected: null, receipt: account.receipt}`.
That lossless reconstruction is the saved public write intent, including stable
operation, account and creation IDs; it is committed before any vault stage call.
The facade never overwrites the existing active vault slot to stage a replacement.

| Operation                             | Durable behavior                                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stage(input)`                        | Save intent with explicit expected-active revision/account, then stage and authenticate. Leaves `active` unchanged. Conflicting pending work rejects.       |
| `reconcile(attemptId)`                | `incomplete` for absent staged material; `ready` only after authenticated open; `active` only for the exact authenticated active receipt. Never activates.  |
| `activate(attemptId, expectedActive)` | Authenticate, then atomically compare pending and active preconditions and publish account plus receipt. Old active becomes the single cleanup pending row. |
| `cancel(attemptId)`                   | Atomically mark only its pending receipt `discarding`, then call vault `discardIntent`; this fences absent material and prevents late stage resurrection.   |
| `reconcile(cleanupAttemptId)`         | Retry exact discard, then clear only that matching cleanup row. Lost cleanup acknowledgements retain durable evidence until resolved.                       |
| `openActive()`                        | Authenticate exact receipt, recheck active revision/account after decryption, then return the transient capability.                                         |
| `close()`                             | Close owned connections and erase untaken capabilities. Does not cancel durable work.                                                                       |

An activation response can be lost after commit. `reconcile(attemptId)` then
returns `active`, and repeating `activate` for that exact active operation returns
the existing record without incrementing revision. Duplicate activation that
races the original may conflict; reconcile before retrying. After cleanup has
cleared, `cancel`/`reconcile` of that old attempt conflicts: no unbounded completion
history is retained. A snapshot showing no such pending attempt resolves that
ambiguity. Never treat a conflict as authority to remove other receipts.

An absent intent remains incomplete across restarts. A readable staged receipt
remains pending across restarts. Failed activation preserves the prior active
record and its vault material. Successful replacement retains the old receipt as
exact cleanup evidence; explicitly reconcile it before staging another change.
Local cleanup is not an identity-retirement authorization. Removed, superseded,
corrupt or unavailable staged material cannot become active. Cleanup that cannot
prove ownership remains pending and blocks new work.

## Boundaries, errors and rollback

The dependency direction is custody → account-recovery public metadata,
account-vault and domain-roots. Persistence and lifecycle helpers are private.
The stable error codes are `invalid-input`, `unavailable`, `locked`, `conflict`,
`storage-failed`, `closed`, and `capacity`; messages never include caller data or
browser exception details. Structural corruption and failed authentication map to
`locked`. Version/capability failures fail closed. Nothing falls back to plaintext.

No public export or stored public state accepts roots, M, R, shares or mnemonic
fields. Display names and identifiers are caller-selected public data; callers
must not intentionally place secrets in them. The facade has no logger, network,
DOM, wallet, UI, store or session imports. Its active record is the sole account
authority for the future consumer; it does not inspect or delete legacy data.

The known next feature is #699's presentation/session adapter. This durable shape
leaves that adapter a public pointer and explicit root capability without adding
an account directory, journal framework, lease manager or pluggable storage layer.
Unknown schema/policy needs a reviewed migration. Code rollback preserves public
and encrypted records for explicit reconciliation; it never deletes a namespace.
The vault's 1,024 retained creation-slot limit still applies. Capacity exhaustion
requires a deliberate policy decision, not automatic namespace rollover.

The [preview vault policy](../../../../docs/preview-vault-policy.md) applies:
no whole-profile rollback/theft or malicious same-origin protection is claimed.
External writes directly to the vault/IDB are outside this facade's ownership
protocol. Electron, Capacitor, Firefox and Safari are not inferred supported.

## Evidence

From the repository root:

```sh
yarn workspace frank typecheck:custody
yarn workspace frank test:custody
```

The real-browser harness compiles a self-contained own-checkout bundle, verifies
its dependency boundary, and serves only loopback fixture code. It creates a
disposable Chrome profile, withholds real transaction acknowledgements, kills the
browser process after stage and activation, and reopens the same origin/profile.
The fixture confirms Codex32 shares, checks identical typed roots/public metadata,
and exercises public/vault aborts, independent instances, late writers, exact
cleanup, malformed records, key loss, authenticated corruption, input mutation,
capability ownership, secret-free serialization and no network/logging calls.
Browser absence fails the gate. `CUSTODY_CHROME` overrides the executable path.
The scoped CI runs those same gates on Linux Chrome.
