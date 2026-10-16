# Baseline follow-up drafts

These are evidence-based local drafts for parent triage, not tracker issues or changes in the
identity-gate candidate. Code remains frozen at `6d341132`.

## Mailbox page-limit fixture and failed-test cleanup

`packages/wallet/chain/contact-payment.jest.test.ts` replaces `fetchCanonicalInboxPage` with
`{ records: [], nextCursor: 'more' }` on every page in its page-limit test. The canonical reader
explicitly refuses repeated cursors. The first assertion rejects before restoration of the
mock; nine later tests then fail with the same repeated-cursor error. Both the candidate sweep
and the exact pre-change factory run reproduce the same ten named failures.

Reconcile the fixture with current cursor-progress requirements and ensure restoration happens
on failure. Preserve repeated-cursor refusal and page-budget/truncation accounting. Acceptance:
the whole contact-payment suite passes, including both cyclic-cursor refusal and a genuinely
advancing mailbox that reaches the page limit. Logs: `/tmp/evm-wallet-gates-full-wallet.log` and
`/tmp/evm-wallet-gates-baseline.log`.

## Forum writer/reader and fixture schema agreement

The topic-burn suite has fifteen failures with `unsupported ... type 15 ... V6.1`; Forum-model
has three failures in `encodeForumReadFrame` with undeclared payload key 7 (C12). The exact old
factory reproduces all fifteen topic failures, and isolated unchanged model/codec code reproduces
the other three. No Forum or codec source changed in this identity packet.

Trace authoritative frame schemas, intended plugin ownership and actual producer/reader
composition before choosing the repair. Update the affected deterministic fixtures and any
confirmed producer/reader gap together; preserve malformed/unsupported-content refusal.
Acceptance: full topic-burn and Forum-model suites pass through actual codec/transport boundaries,
with explicit negative coverage for unsupported versions and malformed known payloads.
Logs: `/tmp/evm-wallet-gates-baseline.log` and
`/tmp/evm-wallet-gates-unrelated-baseline.log`.

## Unsupported eCash reserve option versus admission lifetime

`packages/wallet/chain/native-reserve-support.jest.test.ts` invokes
`EcashWallet.prototype.sendNative.call({ ...empty context... })` and expects an unsupported
reserve error. The unchanged implementation enters `this.admit` before checking the option,
so the actual failure is `this.admit is not a function`. Bitcoin and Solana assertions pass.

Confirm the intended public ordering: whether unsupported options must fail before admission,
or whether this prototype-only fixture omits a required lifetime capability. Preserve explicit
unsupported behavior and avoid initializing custody or mutating spend state for an unsupported
request. Acceptance: meaningful family-boundary tests pass for all three families, including
an assertion that unsupported requests perform no financial effect. Evidence:
`/tmp/evm-wallet-gates-unrelated-baseline.log`; relevant source/test files are identical at base
and frozen candidate.
