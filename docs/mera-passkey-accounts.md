# Mera passkey account contract

Status: implementation contract.

Mera is a frontend credential source. Frank custody remains the sole owner of the
account root, persistence, derivation, and export. A new passkey and an existing
passkey login are separate explicit actions. Login never creates a credential.
There is no backend key, vault, recovery secret, or account conversion.

The candidate pins `@category-labs/mera` to `0.2.0`. Its published package is the
API authority; current GitHub main may differ. Sources:
[official repository](https://github.com/category-labs/mera),
[published package](https://registry.npmjs.org/@category-labs/mera/0.2.0), and
[authenticator support](https://mera.category.xyz/authenticator-support/).

Immutable identity settings:

- RP ID: exact browser hostname, with no parent-domain inference.
- PRF salt: SHA-256 of UTF-8 `frank.mera.account-root.v1`.
- User verification and resident credential: required by Mera 0.2.0.
- Account root: the unmodified 32-byte PRF output, imported through
  `StageAccount.accountRoot` with ordinary Frank root32 recovery metadata.
- Credential discovery: existing-passkey assertions omit an allow-list and do
  not depend on local storage or remembered credential IDs.

The same selected credential, RP ID, and salt reproduce the same root and Frank
addresses. Another supported device needs access to that same passkey, either
through provider synchronization or a cross-device authenticator ceremony. A new
passkey is a new account. Device support and PRF support are separate: WebAuthn
availability permits an attempt; missing PRF fails visibly without staging.

Changing the RP, salt, output transform, or Frank derivation creates a different
identity. These are durable decisions: changing them requires account recovery
and an explicit product decision, not a dependency bump. Ordinary UI changes and
adapter removal are reversible local edits. Existing BIP39/root32 accounts keep
their original derivation; no funded account is converted.

Passkey roots use the existing custody export and Frank backup/recovery path.
They do not require a separate backup format. The newer Recovery Shares change
is independently owned; integration must prove its export/import preserves the
same root and addresses on the combined revision. Deleting the passkey UI must
leave those ordinary root backups recoverable.

Before credential prompts, composition captures the existing account precondition,
legacy revision, and canonical chain context. Cancellation, account replacement,
chain change, or session closure must prevent late results from staging. Staging
only creates an inactive pending attempt; the existing explicit activation and
replacement-consent flow remains authoritative. Failed required restoration keeps
its existing activation/runtime gating. Raw PRF/root bytes stay outside reactive
presentation and are wiped when their operation settles. They are never logged or
sent to a relay. Browser/platform credential implementations may retain their own
internal buffers; JavaScript zeroing does not promise erasure of such copies.

Acceptance evidence must cover synthetic credential create/login determinism,
fresh-storage discovery, same Frank identity and family addresses, root backup
roundtrip, cancellation/unsupported/PRF failures without staging, replacement
consent, account/session/chain races, and English/French visible failures. Real
owner credentials, browser profiles, and personal seed phrases are out of scope.

Verification commands, once dependency execution is allocated:

```sh
yarn install --ignore-scripts
node --import tsx --test app/src/accounts/mera-passkey.node-test.ts
cd app
../node_modules/.bin/jest --config test/jest/accounts.config.cjs --ci --runInBand --runTestsByPath src/accounts/mera-ceremony.jest.test.ts src/accounts/ceremony.jest.test.ts src/accounts/backup-roundtrip.jest.test.ts src/pages/Setup.mera.jest.test.ts src/pages/Setup.repairs.jest.test.ts src/pages/Setup.relay.jest.test.ts src/pages/Setup.multitab.jest.test.ts src/i18n/parity.jest.test.ts src/i18n/locale-completeness.jest.test.ts src/i18n/hardcoded-template-strings.jest.test.ts
cd ..
yarn typecheck:fast
```

The dependency install must generate `yarn.lock`; do not hand-author lock entries.
Run the root backup roundtrip suite again on the combined Recovery Shares candidate.
Synthetic credential tests establish the application's derivation and lifecycle
contract; they do not certify any physical authenticator/provider combination.

Mera's exported signing-session declarations mention `Symbol.dispose`; the adapter
references TypeScript's `esnext.disposable` ambient library without using disposal
at runtime. The existing app uses legacy Node module resolution, so its paths
map points to Mera's exported declaration entry. A standalone legacy-resolution
probe without that mapping reports TS2307; the adapter and synthetic node test
compile with the app mapping. No app-wide resolver or runtime target changes are
required. The repository fast typecheck covers the configured library projects
and custody; it does not typecheck Vue templates.
