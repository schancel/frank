# Browser account integration

`session.ts` owns one runtime wallet and the existing custody facade. Its readonly Vue projection contains only public account metadata, revision, pending status and bounded errors. Wallets, capabilities and domain roots never enter Pinia. Operations are serialized; generation checks fence late completion, and owned root copies are wiped after the typed wallet constructor returns. Custody remains the only persistence/activation authority.

`ceremony.ts` owns transient signup/restore capabilities. Setup selects the policy explicitly, shows one share at a time, saves an independent public descriptor, then verifies exactly the threshold before staging. Restore pins that independent descriptor before share input. Activation is a separate action, including after process restart. Cancelling or leaving Setup consumes the ceremony; failure never invents a replacement account.

`legacy.ts` is the only app mnemonic-construction entry: explicit **Legacy recovery/migration** validates an entered phrase locally and identifies the former account. It creates no wallet or directory registration. The full fresh Codex32 ceremony creates a different identity; it transfers no funds/history and rotates no remote keys. The old wallet row is inspected read-only, never hydrated into Pinia, and remains byte-identical in quarantine. Transfer/history and retirement belong to #737/#738.

This is a Chrome browser preview, not proof of Electron/Capacitor support. Encrypted local storage does not defend against malicious same-origin code or whole-profile theft. JavaScript string disposal is best effort, not forensic erasure. Resident domain roots cannot re-export original shares. Typed messaging and profile publication remain unavailable until the directory/DM integration; the old registration, polling and reconciliation startup paths are disconnected.

## Evidence commands

- From `app`: `yarn test:unit:ci --runInBand`, `yarn lint`, `quasar build`, `yarn test:custody`.
- Run a Quasar browser server on port 9699, then from the repository root: `node app/test/accounts-browser.mjs`. The runner uses a real disposable Chrome profile, retains its profile path, and checks keyboard/focus/live status, double-submit, pending restart, exact confirmation, bounded restore rejection, separate-profile restoration, labelled legacy migration, quarantine bytes, and storage/state/log/network/URL secret exports.
- Set `ACCOUNT_APP_ORIGIN` for another browser server. `ACCOUNT_FAKE_DEMO=true` additionally requires the isolated fake service on port 9701 and its relay on port 9700, with the app launched using the explicit public fake-demo configuration printed by the launcher. It asserts zero-balance activation, EVM-only funding, and native Send.

The last assertion is intentionally **not waived**: before #751, the relay's RPC capability endpoint rejects an unregistered typed identity with HTTP 401 `rpc_auth_failed`. Fake funding itself succeeds at the distinct EVM receive address, but native balance/Send remains blocked. Do not work around this by publishing a typed identity via the legacy directory or disabling production RPC authentication.

The browser script uses only repository-style synthetic phrases, random disposable backup material, and fake funds. Do not run it with a real profile or account. Node/Chrome versions and retained evidence paths belong in the implementation handoff, not in secret-bearing application logs.

## Removed normal paths

The predecessor Setup account/deposit/word-confirm components, seed dialogs, setup account/persistence/lock helpers, and their implementation-specific tests are deleted. Their normal entry points are replaced by the above ceremony/session adapter and real browser tests; they are not retained as a second authority. The wallet store is now a read-only legacy quarantine adapter. Normal startup and wallet consumers never call a mnemonic overload or publish legacy directory keys.

Legacy wallet/registration libraries, remote-wipe component behavior, poller implementations, and unrelated historical work remain intact but are not booted for typed sessions. The unreferenced old xpriv worker is not a normal reachable path and is outside this replacement's production scope. Public profile/contacts data remain projections, not account activation authorities.
