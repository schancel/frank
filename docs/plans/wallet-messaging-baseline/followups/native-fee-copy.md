# Native Send labels an uncapped fee estimate as Maximum Total

## Summary

Native Send review displays an estimated network fee separately, but labels the final row “Maximum Total” / “Total maximal” while its value is only “{amount} {unit} (+ network fee)”. No displayed maximum is calculated or passed as an authorization ceiling to the transfer. The send planner later reads fees independently. This is a misleading pre-submission cost disclosure, not evidence of an actual overspend.

## Evidence and reproduction

Inspected main/P1 landing: `aabb5688f7a04379d49a3f3732d66f3ef5a5b84f`. Parent’s actual pre-submission UI review reported a 0.01 MON transfer to the owned reservoir and a displayed 0.004242 MON estimated fee. No confirmation, signing or spend was performed for this report. This worker performed source inspection only and did not inspect live balances, raw transaction bytes, keys or environment.

Using a disposable mounted Send fixture, enter a valid native destination/amount and open review. Inspect the estimated fee and final cost row without confirming. Current source:

- [Send review](https://github.com/schancel/frank/blob/aabb5688f7a04379d49a3f3732d66f3ef5a5b84f/app/src/pages/Send.vue#L94): separate fee text; “Maximum Total” row uses `maxTotal`, computed at 244 from amount/unit plus a textual network-fee notice. It does not sum a total or establish a ceiling.
- [Review estimate](https://github.com/schancel/frank/blob/aabb5688f7a04379d49a3f3732d66f3ef5a5b84f/app/src/pages/Send.vue#L290): `estimateLegacyFee({wallet, recipient, value})` contributes only formatted `estimatedFeeText`. The numeric estimate and any authorization bound are absent from the captured review record.
- [Final confirmation](https://github.com/schancel/frank/blob/aabb5688f7a04379d49a3f3732d66f3ef5a5b84f/app/src/pages/Send.vue#L322): after account revalidation, params contain captured wallet, recipient, exact recipient value and onSigned callback. `sendLegacy` is preferred, otherwise `send`; no reviewed fee or total cap is passed.
- Public types in `chain/active-chain.ts` (`NativeTransferClient`) and `chain/chain-wallet.ts` (`NativeWalletHandle`) have no reviewed fee-cap argument. `chain/monad-chain.ts:1191–1221` forwards the same amount/callback into the wallet-lifetime owner.
- `chain/evm-legacy-consolidator.ts:265–315` rereads fee data while planning and supplies fees/nonce to the builder. `storage/evm-native-operation-journal.ts` derives and validates `maximumFeeWei` from the resulting frozen member transactions. This is the planned operation’s actual maximum liability, not a user ceiling captured from the earlier review estimate.
- EN/FR `sendAddressDialog.maxTotal` strings in `app/src/i18n/{en-us,fr-fr}/index.ts` say maximum; `maxTotalWithFee` only states amount plus fee. Existing Send tests at 194 and 361 pin that textual value, not a cap.

## Expected behavior

Present amount and estimated network fee as distinct quantities. An uncapped estimate must not be labelled as a maximum or guaranteed total. If the product instead promises a maximum, explicitly authorize a fee/total ceiling and enforce it before signing across the actual transfer and builder path; display alone cannot enforce it.

Preserve the intended recipient amount; do not silently reduce it to make room for fees. Preserve captured canonical network, wallet and account-generation binding and exact-byte retry/recovery.

## Impact and limits

Users cannot infer an enforceable upper cost from this review. Fee/source conditions may change between review and planning. No executed transaction or overpayment was observed. P1 already validates solvency and freezes actual fee fields before signature/exposure; this report does not assert that fees are unbounded in the signed transaction or that replay raises them. Missing estimate is currently displayed honestly as unavailable, and confirmation remains possible; whether unavailable estimates should block confirmation is a separate explicit product choice.

## Acceptance criteria

- EN/FR review no longer calls an amount-plus-unspecified-fee notice a maximum. Known fee remains explicitly estimated; unavailable fee remains unavailable, without fabricating a numeric total or cap.
- If this ticket is resolved through truthful copy only, make that limitation explicit: it does not add an authorized spending ceiling or change fee planning.
- Mounted EN/FR regressions inspect the actual review with known/unavailable estimate, preserve amount/network/recipient, and prove initial review/cancel has zero sign/broadcast effects.
- If an enforceable maximum is chosen, first accept the separate typed transfer/builder/durable authorization contract described in the options artifact. A higher post-review quote must reject or require renewed review before any signature; retries retain the original exact authorized bytes and fee bounds.
- No shared-input reservation changes, recipient-value shrinkage, new fee feed, replacement transaction, network identity changes or broad wallet refactor.

## Dedupe and related work

Fresh search for fee/maximum/estimate/native-send items found closed [#535](https://github.com/schancel/frank/issues/535), which introduced the review boundary and requested estimated fee/maximum total, and closed [#386](https://github.com/schancel/frank/issues/386), a broad fee-estimator design. Neither is an open owner of this specific current label-versus-authorization discrepancy. Suggest a new bounded follow-up linked to #535, with #386 as design context; no reopening or implementation claim yet.

Open #1235 owns shared input admission and provisional state, not user fee authorization. #1249 owns intended-versus-observed received payments, not this outgoing cost label. P1/#1230 owns frozen operation recovery; preserve its fee/amount and exact-replay guarantees rather than interpreting its derived maximumFeeWei as a prior UI consent ceiling.

Status: maintainer accepted the smallest copy-only containment. Exact production scope: the two existing EN/FR maximum-row label values, plus focused existing Send mounted tests. Keep existing translation keys and local identifiers; do not change Send production behavior, signing APIs or confirmation eligibility. Real fee authorization remains a separate NEEDS_SPECIFICATION follow-up. Source/actual pre-submission review evidence only; no actual-overspend claim.
