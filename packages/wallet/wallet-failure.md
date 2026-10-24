# Wallet failure facts

`wallet-failure.ts` is the public, family-neutral description boundary. It has no
imports. Authoritative selection and transport adapters record local facts; callers
read descriptions without parsing messages, traversing causes or changing errors.
It owns no operations, reservations, balances or persisted state.

Facts are keyed by exact rejected object identity. Observation context accumulates
independently of diagnosis. Retry vetoes always dominate transport facts. Conflicting
diagnoses fail closed. The first explicit diagnostic cause is retained. Frozen errors
and proxies need no mutation; unregistered objects and primitives remain unknown.

A transient diagnosis never proves a send had no effects. Keep the original rejected
object for the canonical no-effect accessor, and consult original-operation evidence
before retry. Do not copy labels, replace errors, or search causes for authorization.

`evm-rpc-failure.ts` is the EVM adapter's vendor normalization boundary. Chain mismatch,
authorization and cancellation must precede transient status/code handling. RPC
insufficient balance is not proof that the wallet inventory is insufficient.
Local response-size and streaming refusals carry a nontransient transport veto.
The relay's existing credential-safe error replacement preserves only finite retry
vetoes: never the original transport cause, arbitrary details or financial effect
labels. Later observation or transient facts cannot clear that veto.

Focused checks from the repository root:

```sh
yarn --cwd packages/wallet test wallet-failure evm-rpc-failure evm-transaction-set-runtime --runInBand
yarn typecheck:fast
```

The import-boundary test includes negative fixtures; source/runtime and original-send
tests remain necessary to prove facts are attached at the correct boundary.
