# Independent Review (`hd-funding-provenance`)

- **Reviewed Commit**: `a3cb8ba85c7f78bba335768f5229ceb5210de290`
- **Base Commit**: `96c815df75c6f402e9220a28fc275fadb2d8d22d`
- **Verdict**: `SAFE TO INTEGRATE`
- **Reviewer**: Independent Code Review Subagent (`92c5fc8e-7b96-41be-a04c-9966c652da6b`)

## Summary

- **Correctness, Provenance Retention & CAS Invariants**:
  - `SubAccountRecord` and `TerminalSubAccountCheckpoint` retain `funding: SubAccountFundingCollection` (`version: 1`, `attempts`, optional `hold`) across `funding`, `available`, `in-use`, `spent`, `retired`, restart, and terminal checkpoint projection.
  - Transaction semantics (`rawTx`, `txHash`, `valueWei`, recovered sender, derived HD recipient, plain transfer data/accessList, positive `gasLimit`/`chainId`, `expectedChainId`, safe non-negative `nonce`, unique `txHash` and `(sender, nonce)`) and anchored observation invariants are validated on registration and store reload.
  - `recordFundingObservation` enforces `expectedGeneration` CAS inside `store.mutate`, increments `generation` on changed observations (refusing at `MAX_SAFE_INTEGER`), treats identical replay as idempotent, refuses stale `A -> B -> A` or post-resolution overwrites, and preserves concurrent contributors.
  - Multi-funder preparation holds (`funding.hold`) keep partially funded targets in `funding` across interruption and reopen until all expected contributors have verified `included` (`success`) observations and `prepareBurnAccountExclusive` explicitly completes the hold.
  - Missing receipts with positive balance (`pending`) and `unknown-execution` receipts remain `unresolved` (`funding`) and non-selectable; `evm-input-admission` holds any sub-account in `funding` or carrying an `unresolved` attempt or active `funding.hold`.
- **Format & Boundary Compliance**:
  - Advances wallet manifest to v4 (`sub-account-pool-v4-funding-evidence`, `change-pool-v2`) and pool envelope to v4, refusing legacy v3 manifests and pool stores fail-closed without mutating disk bytes.
  - Only the 8 authorized production files were modified.
- **Validation**:
  - 10 Jest suites (504 tests) and `yarn typecheck:fast` (25/25 projects) passed with 0 failures.
  - Findings: 0 `CONFIRMED`, 0 `PLAUSIBLE`, 3 `SETTLED` with counterevidence.
