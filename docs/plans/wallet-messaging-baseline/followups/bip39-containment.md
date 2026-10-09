# Preserve data and identity when BIP39 import is unavailable

## Summary
The current Setup BIP39 import can automatically reset existing custody and same-origin wallet databases when storage is locked or a snapshot fails. It also hashes the phrase/path into a new domain root, activates a different identity, and returns the scanned legacy address as though that account were imported. Neither behavior is an acceptable recovery outcome.

## Evidence and reproduction
Independently verified against `1e8b652eaa865b45b563c3d758a8658866b70df7`: `Setup.vue` invokes `importBip39Wallet`; the session import calls reset before staging on locked/unavailable state or snapshot failure. Reset enumerates custody, wallet and message databases beyond a single import namespace. Closed #1151 and #1089 explain historical introduction, but do not authorize deletion during import.

A pure offline check using the repository public synthetic BIP39 vector and its selected path demonstrates that the scanner's returned address differs from both the activated authentication identity and native receive/signing address. The implementation never stages the scanned private key. No owner phrase, funded wallet, browser import, reset or live loss was used or observed.

## Expected behavior and accepted containment
Until standard-account import has its own custody/identity contract, keep local identification available and reject import/activation explicitly. Show localized English/French unavailable guidance without resetting, staging, activating, replacing or navigating as a successful import. Preserve normal Codex32 creation/restore and the independent explicit reset action.

## Acceptance criteria
- The real public import API rejects with a typed unavailable result in fresh, ready, locked, unavailable and pending states; no custody, wallet construction or database-deletion effects occur.
- Mounted Setup identification uses the real local scanner and rejected API, displays the identified account plus truthful unavailable guidance, and performs no RPC/probe, saved relay configuration, activation, success event or navigation.
- Synthetic existing custody/journal sentinels stay byte-identical; invalid input and cancellation remain safe.
- Delete the obsolete phrase-to-root conversion and automatic-reset import implementation rather than leaving dormant success code.
- Preserve ordinary Codex32 activation and multi-tab boundaries through focused regressions and independent review. Fast typecheck does not cover the entire Vue app.

## Scope and ownership
Accepted by the maintainer for bounded autonomous repair: `app/src/accounts/session.ts`, `app/src/pages/Setup.vue`, and `app/src/i18n/account-recovery.ts`, plus focused existing tests. Persistent and wire formats do not change. General explicit-reset deletion scope and a correct standard-account import design remain separate follow-ups. No migration, new derivation scheme, funded key conversion, or live recovery test is authorized by this containment.
