# Account vault

`@frank/account-vault` is the bounded browser preview storage seam for typed domain
roots. Import only the package facade. It depends on the frozen domain-root
registry; storage, framing and WebCrypto implementation modules are private.
There are no wallet, UI, ceremony, network or DOM dependencies.

Read [the preview policy](../../docs/preview-vault-policy.md) before integration.
This package does not complete account setup or authorize account identity reuse.

```ts
import { createVaultWriteIntent, openPreviewVault } from '@frank/account-vault'

const vault = await openPreviewVault({ namespace: 'account-preview' })
const intent = createVaultWriteIntent({ context, expected: null, operationId })
// #699 must first durably save this public intent with its pending account creation.
const receipt = await vault.stage(intent, typedPurposeRoots)
// #699 must atomically activate the account referencing this receipt before network use.
const ownedRoots = await vault.open(receipt)
// Caller owns these new byte arrays and should erase them when finished.
ownedRoots.forEach(root => root.bytes.fill(0))
vault.close()
```

`context` is a `VaultContext`: stable public account/creation IDs, fixed recovery
format and registry, ordered purpose subset, custody epoch, public recovery
fingerprint and retirement context. `typedPurposeRoots` is an ordered array of
`DomainRoot` values matching those purposes. The facade does not accept account
roots, master payloads, shares or mnemonic phrases. It validates the typed shape;
the caller is responsible for supplying actual derived domain material rather
than falsely labeling other 32-byte data.

For replacement, create a new intent with the current receipt as `expected` and
a distinct operation ID. Revision and authenticated context are checked together.
For a lost response, call `reconcile(intent.receipt)`. `committed` identifies the
stored receipt; `open` must still succeed before using material. Retrying `stage`
on an already committed intent yields `conflict`; it never activates new material.
Do not mint new IDs to evade an unresolved outcome. `remove(receipt)` atomically
deletes its key/ciphertext and leaves a local fence; repeat removal is idempotent.

## Verification

From an installed repository workspace:

```sh
yarn workspace @frank/account-vault typecheck
yarn workspace @frank/account-vault test
```

The browser harness uses the repository's installed `esbuild` and Node's built-in
WebSocket client. It starts installed Chrome headless (override its path with
`VAULT_CHROME`), serves only loopback fixture code, and creates an isolated
temporary profile. Three separate Chrome processes prove creation, persistent
profile reopen, and failure regressions. It deletes only its own temporary
profile afterward. It never opens a user's browser profile or uses account funds.
Browser absence is a failed prerequisite, never a mocked success. Build metadata
also checks that registry imports resolve inside this checkout and that the
package exposes only its facade.
