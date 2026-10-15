# H0 implementation evidence

Base: `3951bbf2557a31d7380a3ae6b07431f966e031b5`. Source candidate: `2b017a31cf0dc0584502ec6420d948f33efaae66`. Branch: `refactor/read-only-custody-open`. The final gates below ran against exactly the source and test contents committed in that source candidate; the subsequent policy/contract clarification changed documentation only. This evidence is a separate documentation commit for independent coordinator review.

## Outcome and ownership

Custody still owns public account state and activation/cleanup sequencing. The preview vault still owns encrypted roots, exact receipt authentication and discard/removal fences. No public API, record/schema, derivation, root-purpose allocation or cleanup owner changed.

Both private IndexedDB open helpers abort first creation or unexpected upgrades on the inspection path. Only the resulting deliberate first-creation abort is treated as absence; blocked, unsupported, malformed and failed opens remain failures. Authorized mutations use explicit creation paths. There is no enumeration/open race and no absence cache.

Custody opening validates existing public state before returning, and snapshots do not open the vault. Secret access opens the vault lazily. Vault opening and authenticated reads no longer run the writable capability probe; first mutation qualifies the existing persisted nonextractable-key round trip before creating its root namespace. Reads keep existing ciphertext/fences unchanged. Connections are scoped to each operation and closed in `finally`; facade closure revokes capabilities and closes late connections before they can publish results.

The two allowed READMEs explain the new qualification boundary. The coordinator separately authorized the narrow eager-probe correction in `docs/preview-vault-policy.md`; that scope clarification is recorded in the contract. Existing capability databases are not deleted by production code.

## Fail-before and browser acceptance

Before production edits, new inventory assertions failed against the original implementations:

- `yarn --cwd app test:custody`: `read-only custody does not create databases` (`/tmp/frank-h0-custody-before.log`).
- `yarn --cwd packages/account-vault test`: `absent vault inspection creates no namespace or probe` (`/tmp/frank-h0-vault-before.log`).

The final real Chrome suites compare database inventories around absent facade opening and reads, then create an account through another facade and verify the original reader sees it. Vault checks compare ciphertext, receipt fences and capability-probe ciphertext before/after authenticated reads. Delayed real IndexedDB success callbacks exercise closing during lazy secret opening and mutation qualification; subsequent deletion of only those disposable test databases proves no late connection leaked. Existing restart, missing/corrupt key, lost acknowledgement, replacement, cancellation and cleanup-race cases pass.

Eager-probe failure fixtures now require read-only inspection/authentication to succeed while structured cloning is disabled, and require the first authorized mutation to reject. A failed custody stage retains its public pending intent and leaves the prior active account unchanged. Vault process restart additionally compares exact account-root bytes, not only their derived roots.

## Final gates

| Command from repository root | Result |
| --- | --- |
| `yarn typecheck:fast` | 23/23 configured projects pass |
| `yarn --cwd app test:custody` | Actual Chrome stage, activation and fresh-process reopen pass; 364 regression assertions across 19 cases; zero network calls/logs |
| `yarn --cwd packages/account-vault test` | Actual Chrome create/reopen pass with exact root bytes; 269 regression assertions |
| `yarn --cwd packages/account-vault test:node` | 5/5 tests pass |
| `node_modules/.bin/prettier --config app/.prettierrc.json --write app/src/accounts/custody/index.ts app/src/accounts/custody/persistence.ts app/src/accounts/custody/test/suite.ts` | Scoped app files formatted before final gates |
| `git diff --check` | Pass |

Final logs: `/tmp/frank-h0-typecheck.log`, `/tmp/frank-h0-custody.log`, `/tmp/frank-h0-vault.log`, `/tmp/frank-h0-node.log`. Browser: Chrome `155.0.8059.40` on this macOS host. Each browser harness owns its disposable profile; no user profile or funded wallet is used. These results qualify this tested host, not untested webviews or browsers.

Owned dependency overlays link installed external packages and resolve `@frank/*` to this worktree. No manifest, lockfile, shared worktree or shared dependency directory changed. Source remains within the authorized files plus the expressly approved policy wording correction.

## Remaining work

Opening no longer proves writable persistence; the first authorized mutation does. Retention holds, destructive-reset fencing, encrypted operation-secret custody and atomic-swap runtime remain separate successors. This change does not make reset paths safe or establish malicious cryptographic assurance. No push, merge, deployment, funded transaction or user-data deletion occurred. The coordinator owns independent review and integration.
