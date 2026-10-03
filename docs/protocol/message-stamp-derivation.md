# Provisional message and stamp derivation allocation

Status: **ACTIVE PURE API — PROVISIONAL PREVIEW**. Owner: @schancel. Activation: [#745](https://github.com/schancel/frank/issues/745), following the independent protocol/security review of [#734](https://github.com/schancel/frank/issues/734) landed in [#740](https://github.com/schancel/frank/pull/740). The [original D1–D11 proposal and frozen evidence](proposals/message-stamp-derivation/README.md) retain their historical provenance. [#746](https://github.com/schancel/frank/issues/746) corrected the existing public HD primitive's zero-tweak boundary before activation.

The active owner is [`@frank/role-keys`](../../packages/role-keys/README.md). This allocates only the accepted deterministic child schedules; it adds no registry/recovery identifier, root purpose, network salt, directory codec or runtime consumer.

| Role | Existing root purpose | Exact path |
| --- | --- | --- |
| Auth P | 5: identity-authentication | `m/44'/60'/1'/0/0` |
| Message M | 4: messaging-encryption | `m/44'/60'/4'/0'/{g}'` |
| Stamp P′ | 2: evm-wallet | `m/44'/60'/2'/0'/{g}'` |

The BIP32 seed is the selected existing 32-byte `frank-domain-roots-v1` output. Recovery remains `codex32-master-v1`. All five HKDF purposes, labels and bytes are unchanged. Auth retains the reviewed preview exception with two non-hardened final components. Main, funding and change paths and addresses are unchanged; the stamp branch shares the existing EVM root's compromise domain.

`g` is an exact integer from zero through 2147483647, independently selected for message and stamp. The facade accepts bigint before checking this bound. There is no rounding, modulo, fallback role, index skipping, probing or seed scan. BIP32 rejects a zero/out-of-range master, IL ≥ order, or a zero resulting child; IL zero with a valid child is permitted. Every step uses the requested exact index. Any failed child or role collision aborts the entire requested leaf set. A role collision includes point negation. There is no state mutation or publication in this API.

Derivation is network-independent. Equal roots and generations produce equal points across networks and are intentionally linkable. No forward secrecy is added. A root compromise exposes its deterministic generations. At maximum generation there is no wraparound; any future rotation requires a separately reviewed migration.

The public seam carries registry, role, purpose, path, generation and point. Disposable capabilities retain only leaf scalars; caller roots remain caller-owned. No root bytes, chain codes or role xpubs are public state. See the package's precise borrowing, disposal and best-effort erasure contract.

D8–D11's directory authority and persistence obligations remain **prerequisites to runtime adoption**, not assertions made by local point comparison. `matchLocalRolePoints` derives only supplied generations and compares supplied points. Optional previous stamp is explicit and adjacent; omission stays absent. Deriving a previous key does not authorize grace. Supplied exclusions may reject repeated/negated points but do not establish complete authenticated history. Fresh-head acceptance, network/subject anchors, exact T1, signatures, contiguous authenticated linkage, prior-generation membership, rollback protection and atomic role/directory-state commit remain with the next bounded admission and persistence stage under #133/#696. No caller boolean can supply that authority.

The provisional choice is now active for this pure opt-in API. Before runtime adoption rollback removes the package and this allocation pointer. Once any consumer uses these schedules for published or persisted state, changing them requires an explicit migration. This does not close #696/#132/#232/#198, implement seal/open or payment construction, enable signing publication, or change held #258.
