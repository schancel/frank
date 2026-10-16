# Vietnamese catalog candidate

Tier 2 catalog implementation under `contract.md`; only `app/src/i18n/vi-vn/` and this evidence file are owned. Base catalog is f409b28a0af0f083d72bfb847c34cfe4865ffb0e plus the coordination contract. No host wiring, registry, English or French changes.

`app/src/i18n/vi-vn/index.ts` contains a complete standalone Vietnamese catalog: 1,660 string leaves, including the resolved English `accountRecovery` namespace, `settings.languageAutomatic`, and the signed UI owner's stable `signedSwap` namespace. There are no imports, English spreads, runtime fallback scaffolding or translation service calls. Proper product/network names, asset symbols and protocol identifiers are retained. Vietnamese has no grammatical singular/plural distinction; parallel singular/plural keys remain present with natural matching wording.

Verification on 2026-10-15 used read-only existing dependencies at `/Users/shammah/repos/frank/node_modules`:

- TypeScript transpilation and evaluation of the catalog succeeded without parse diagnostics.
- Recursive leaf-key parity against resolved English plus the automatic-language setting and signed swap additions: 1,660 / 1,660, no missing or extra keys.
- Exact per-message interpolation token, numeric literal, URL and HTML-tag parity passed.
- `@intlify/message-compiler.baseCompile` compiled all 1,660 Vietnamese messages with zero errors.
- All 78 values identical to English were inspected. They are product/network names, asset-symbol zero balances, AVU formula/benchmark labels, email/CC/BCC conventions, established Bot/Email labels, EULA, Google Calendar, or placeholder-only formatting strings. No untranslated English sentences remain.
- `node /Users/shammah/repos/frank/node_modules/prettier/bin-prettier.js --check app/src/i18n/vi-vn/index.ts` and `git diff --check` passed.

Signed swap English source was read from `/Users/shammah/repos/frank/.worktrees/signed-negotiation-ui/app/src/i18n/en-us/index.ts`; full-file SHA-256 at verification: `cb5d013a85e12b13f615878174de5b04875a3fd0896d985fb406f739d5f07710`. This is evidence of the inspected source, not authority to integrate its other changes.

Safety-sensitive wording preserves: recovery shards and threshold access risks; public descriptor metadata versus proof of ownership; restore failures without reset; payment intent versus actual receipt; pending/unknown submission versus failure; network fees despite reverted payments; retained reservations and delivery recovery; duplicate-payment warnings; signed negotiation acceptance without funds transfer or spending authorization. Existing English product claims are translated faithfully rather than broadened.

No native-speaker certification or runtime language/render verification is claimed. Parent integration owns rendered smoke checks, combined source parity, full typecheck and independent content review. No full typecheck, installation, live services, secrets, funds, push, deployment or main merge was performed.

For parity reproduction, load English via TypeScript CommonJS transpilation with `accountRecovery` bound to the shared module's `en` export, add `settings.languageAutomatic`, and use only `signedSwap` from the stable signed UI catalog. Flatten nested string leaves, compare sorted paths and each string's `/\{[^}]+\}/g`, `/\d+(?:[.,]\d+)*/g`, URL and HTML tag matches, then call `baseCompile` on each Vietnamese value with a throwing `onError` callback. The checks were run against the final formatted catalog, not only the translation input.

## VI-01 follow-up

Independent review and a separate verifier identified six read-failure messages whose Vietnamese wording could imply that no funds or transaction value existed. Changed `accountRecovery.balance_unavailable`, `walletPanel.balanceUnavailable`, `walletPanel.tokenBalancesUnavailable`, `walletPanel.tokenBalancesStale`, and `receiveBitcoinDialog.balanceUnavailable` to explicitly say the balance cannot be loaded. Existing retry and last-known-balance suffixes remain. Changed `transactionDialog.valueUnavailable` to say the transaction value has not been determined. This distinguishes inability to observe a value from a zero or absent value. No other catalog strings changed.

Reran the scoped checks against the corrected catalog: 1,660 leaf keys match; exact placeholder/numeric/URL/HTML parity passes; all 1,660 messages compile without errors; TypeScript parse, Prettier check and `git diff --check` pass. Independent review of the new tip remains the parent's next step.

## Signed swap wording follow-up

Read the English `signedSwap` namespace directly with `git show 7a17f623:app/src/i18n/en-us/index.ts`. Changed exactly three Vietnamese leaves to match that revision: `negotiationOnly` now scopes the no-transfer/no-authorization statement to the money used for the swap itself; `states.accept` says authenticated acceptance does not authorize transferring the swap money; `errors.failed` retains any saved authorization if one exists instead of assuming one exists. The principal wording does not imply that message stamps cannot be paid.

Scoped checks against the exact English namespace at 7a17f623 passed: all 1,660 keys and placeholder/numeric/URL/HTML matches agree, all 1,660 messages compile without errors, TypeScript parse succeeds, and `git diff --check` passes. Prettier formatted the changed file. A direct comparison with the previous Vietnamese tip confirms that only these three string leaves changed.
