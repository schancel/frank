# Frank Engineering & Architectural Invariants for Agents

These rules define the intended architecture across the monorepo. Existing code is not precedent when it violates them. Identify relevant gaps and fix them within the agreed scope or record concrete follow-ups; do not silently expand a task into a whole-tree rewrite.

## 1. Canonical chain identity and configuration ownership

- Use the exact canonical string `chainIdentifier` for each network everywhere: frontend, backend, inventories, caches, database keys, operation locks, relay routing, signed request scopes, and wire payloads such as `WalletSyncItem`.
- The shared protocol registry is [docs/protocol/chains/v1.json](docs/protocol/chains/v1.json); its [README](docs/protocol/chains/README.md) defines identity and capability semantics. Use its `id` values rather than inventing spellings. Add supported protocol networks at the authoritative source, not only in a consumer's local table.
- Family (`evm`, `solana`, `bitcoin`), chain kind, display name, network tag, CAIP-2 name, and native transaction chain ID are distinct concepts. None substitutes for the canonical network identifier in lookups or cross-chain records. For example, `monad` and `evm` are not network keys.
- Native chain IDs are valid where the native protocol requires them, including EVM signing and RPC identity verification. They must not become Frank's cross-chain identity. Preserve registry-required checkpoint verification; a matching numeric ID alone does not establish upstream identity.
- Validate external identifiers at the boundary. If external aliases must be accepted, resolve them there and carry only canonical identifiers internally. Reject unknown or unsupported identifiers explicitly; never silently select Monad or another default network.
- Before changing configuration, trace authoritative definitions, consumers, and any generation pipeline. Rust configuration currently includes the protocol JSON directly. Do not assume the separately declared TypeScript wallet registry is generated without verifying that relationship.
- Shared protocol facts have one source. Client presentation settings and relay operator settings may extend them, keyed by canonical identifier, but must not independently redefine identity or protocol capability limits. Relay-advertised capabilities are the configured subset of protocol-permitted capabilities.
- Edit generated artifacts through their source and generator. Document source paths, output paths, and exact regeneration/check commands beside the generator or registry. Update affected client and relay consumers together and check their agreement. Never invent a generation command or hand-maintain a supposedly generated copy.

## 2. Chain families, adapters, and naming

- EVM, Solana, and Bitcoin-family configurations/adapters are peers. eCash belongs to the Bitcoin/UTXO family. Monad and Ethereum Sepolia are peer EVM network configurations; EVM is not a specialization of Monad.
- Model family configuration with a discriminated union and genuinely shared metadata. Do not force EVM gas, nonce, address, or transaction concepts onto Solana or UTXO implementations.
- Network facts belong in configuration: identifiers, units, endpoints, deployments, supported assets, and capabilities. Behavioral differences belong in family or network adapters: transaction construction, submission, balance discovery, and verification.
- Select adapters explicitly in composition/configuration. Do not infer behavior from identifier prefixes, display names, or scattered network-name conditionals.
- Shared EVM implementations and contracts use `Evm…` names. Reserve `Monad…` for actual Monad-specific configuration or behavior. A generic EVM type must not extend or alias a Monad-specific type. Apply the same rule to other families and chains.
- Frontend and protocol consumers use configured metadata and capabilities instead of maintaining their own network tables or feature switches. Unsupported capabilities produce an explicit unsupported result.

## 3. Wallet custody, state ownership, and sync

- Custody owns keys, derivation, and signing. Wallet state owns inventory, reservations, and spend transitions. Messaging consumes wallet capabilities; custody must not depend on messaging transport or application message plugins.
- Wallet handles must not expose messaging methods such as `sendSelfDirectMessage` or inbox orchestration such as `processSyncTransaction`.
- Each durable fact has one authoritative owner. Document which inventories, caches, and indexes are derived views and how they are rebuilt or updated. Do not independently mutate competing representations of the same spend state.
- Attempt journals may own distinct submission/recovery facts; do not delete them merely because an inventory also exists. Establish ownership and recovery behavior before consolidating stores.
- Expose typed operations across boundaries. Do not reach into another component's private store, mutate its records directly, or use `any` to bypass the wallet/sync contract.
- Incoming and self-sent wallet sync items go through `applyWalletSyncItem` at the wallet sync boundary (`@frank/wallet/sync-dispatcher`). Validate wallet/chain affinity before mutation. Apply changes through the authoritative state owner's public operations, not a hardcoded list of historical pool implementations.
- Repeated sync must be safe. Partial failures must be observable and recoverable, not logged and represented as complete success. Spent-account retirement, nonce advancement, and UTXO changes must respect their family semantics.
- Consolidators emit sync events; composition wires local application and any self-mailbox broadcast through the messaging service. Consolidators and custody do not acquire transport dependencies.
- Preserve chain isolation, exclusive spend reservation, and recovery of ambiguous submissions. A timeout or restart is not proof that a payment failed and is not permission to pay again.

### Payment operations, reservations, and maintenance

These rules record owner-confirmed design intent. They do not assert that the current implementation already satisfies it.

- A wallet and its spend pool are scoped to one canonical chain. Within that scope, an account-based spendable entry can be identified by `[account, nonce]`; do not require a redundant chain field on every entry. Carry or validate `chainIdentifier` at cross-wallet, shared-index, persistence, relay, and sync boundaries.
- HD keyrings derive keys and addresses. Spend inventories track available UTXOs or account/nonce states with attached signing material. Construction views, reservations, and journals serve distinct purposes; one owner per fact does not mean one object for the whole wallet.
- Normal Frank-to-Frank payments can gather value across many stealth/ephemeral accounts or UTXOs. Their payment transactions are normally independent. Prefer exhausting inputs and avoiding address reuse where practical; do not force every payment through a single reusable account or a consolidation pipeline.
- Legacy recipients and contract calls on account-based chains may require a separate consolidation workflow: fund one owned account, wait for the required chain state, then send the external transaction. A single sufficient account may bypass consolidation. Dependency orchestration belongs to this workflow, not every payment.
- Provisional accounts/outputs in a construction view are usable only by the owning operation, subject to chain execution rules. Planning a dependent spend does not make its funds available to unrelated operations.
- Reserved means a specific UTXO or `[account, nonce]` state is claimed by an operation. Other payments and background maintenance must exclude that entry. Enforce any additional nonce-ordering constraints in the family adapter; do not turn an input reservation into a wallet-wide messaging lock.
- Unrelated messages must be able to construct and send using other available inputs while an earlier operation is pending or reconciling. Short atomic selection/reservation sections are appropriate; network waits and uncertain attempts must not hold a global send queue. Reconciliation must continue independently of new sends.
- Persist the complete encrypted message, intended payment, signed transaction set, and reservations before handing transactions to any party that can broadcast them. Relay acceptance/delivery and chain settlement are distinct facts. Unsigned plans that were never externally submitted need not survive a crash; recover their reservations without losing derivation ownership or mistaking a potentially submitted operation for an unused plan.
- Recovery should reconcile and finish the original authorized payment and message delivery, accounting for relay submission and recipient rechecking/rebroadcast. Retry the existing operation, not a fresh payment for the same message. Keep recovery within the authorized destination, amount, and spending constraints.
- Messages must identify the intended recipient amount separately from fees and separate stamp costs so recipients can distinguish pending, partial, and complete payment. Do not report the full amount as received merely because the message arrived.
- UI deletion, discard, retry exhaustion, or a relay rejection is not by itself proof that previously exposed signed transactions cannot land. Do not release their reservations or claim zero financial effect without reconciling their actual submission/spend state. Delivery reliability is especially important once funds may have moved.
- Residual value need not always move to fresh change addresses. When an account nonce is consumed, retire the old spendable state and account for the remaining balance under the appropriate next nonce; do not leave the old pair selectable. Keep pending and confirmed transitions explicit.
- Background EVM maintenance may split oversized balances and consolidate/sweep to maintain the agreed amount distribution. It must respect operation reservations and skip moves costing more than the value moved. Dirty-account sweeping and oversized-deposit distribution are distinct decisions: do not impose a blanket nonce-zero exclusion that would prevent distributing a large fresh deposit. Confirm eligibility and distribution policy before changing it.
- Native/token inventory layout and detailed maintenance policy remain design questions. Do not infer approval of a universal asset model or multi-chain/AVU funding coordinator from these invariants.

## 4. Message plugins and protocol boundaries

- A message-type plugin owns its application payload types, schemas, schema-version handling, encoding/projection, semantic validation, and feature state transitions. Games, swaps, and other application features do not belong in wallet custody or generic transport switches.
- Core codec owns canonical encoding primitives, framing, shared structural limits, and validation context. Protocol identifiers and version allocations remain centrally governed. Plugin extraction must not bypass enclosing validation or reset traversal/size budgets.
- Separate pure schema/codec code from runtime effects. Separate plugin UI entry points from headless logic so bots and frontend share feature rules without pulling in Vue/Pinia.
- Inject narrow capabilities where needed, such as payment verification or signing. Do not require every plugin to receive an ethers provider, an entire wallet, or unrelated stores.
- Messaging owns encryption, delivery, retries, reconciliation, and dispatch through composed message codecs. It must not enumerate blackjack, raffle, email, or other application-specific payloads. Avoid ad-hoc JSON-inside-text fallbacks for unsupported feature formats.
- Application composition explicitly installs plugins and renderers. Avoid global registries populated by import side effects. Adding a feature should require its plugin and composition entry, not edits to wallet internals, generic transport, and central rendering switches.
- Define unsupported-type/version behavior explicitly. Preserve or report unsupported content as the protocol permits; never execute it or treat it as a validated known item. Malformed known payloads must still fail validation.

## 5. Dependency direction and composition

- `@frank/codec`: pure encoding/validation infrastructure and core protocol schemas; application-specific schemas have explicit plugin ownership.
- `@frank/cashweb`: relay/protocol clients and transport records; no imports of wallet implementation types, including type-only back-edges.
- `@frank/wallet`: custody, chain implementations, wallet state, and typed sync application; no dependency on application feature implementations.
- Message feature modules: depend on codec primitives and explicit capability contracts, with separate runtime and UI entry points.
- `app`: frontend composition, Vue/Pinia presentation, and user interaction. Financial recovery policy must be usable and testable outside UI stores.
- Application/host composition owns environment loading, service construction, network selection, and lifecycle. Shared services receive dependencies instead of reading mutable global state or silently constructing a default network.
- Bind in-flight operations to a stable wallet/session and chain context. Changing the selected UI network must not redirect an existing send or reconciliation operation.
- Conversation identity is distinct from peer identity. Support one default direct thread plus explicitly created independent conversations with the same peer or bot. Use stable conversation identities; editable subjects are presentation, not unique routing keys. Show subjects in the conversation list and main chat view.
- Email-gateway threading is a required consumer of this model. Separate threads through the same gateway, including threads with equal subjects, must retain their own reply relationships, messages, unread state and payment/delivery reconciliation. Never collapse all conversations merely because they share a peer or gateway address. This supersedes the earlier blanket direct-peer collapse policy in #1178.
- Prefer cohesive modules and small capability contracts. Do not introduce a DI container, universal service interface, or new package solely to look modular. A boundary must clarify ownership and dependency direction.

## 6. Development baseline and format breaks

- Frank is pre-user. Prefer a coherent new baseline over backward compatibility. Old APIs, development data formats, and wire formats may be deliberately broken as part of the agreed change.
- Do not add migrations, dual readers/writers, compatibility aliases, or fallback implementations merely to preserve obsolete development behavior. Update affected writers/readers together and delete superseded code.
- Unsupported old data should fail clearly with a documented development reset path. Format changes do not implicitly authorize deleting private keys, funded wallets, or unrelated local data; scope destructive resets explicitly.
- Restart/recovery within the new format is required. Dropping compatibility does not relax payment accounting, concurrency, persistence, or key-derivation correctness. Any intentional derivation change must be explicit in the change contract.

## 7. Verification and engineering workflow

- All configured projects must compile cleanly under `yarn typecheck:fast`. Compilation is necessary but does not prove architecture or financial correctness.
- Validate the boundary affected: registry/client/relay agreement, canonical identifier round trips, dependency direction, or end-to-end behavior. Use all existing chain families when verifying a shared family/configuration boundary.
- Wallet-state changes require meaningful coverage of concurrent selection, chain isolation, interrupted submission, restart recovery, and repeated sync as applicable. Messaging/plugin changes require send/receive integration and explicit unsupported/malformed-item behavior. Exercise the app-to-bot flow when its boundaries change.
- Back architectural rules with focused automated checks when changing the relevant boundary: generated-output/registry consistency, prohibited imports, and behavioral invariants. Documentation alone is not enforcement; do not claim a check exists until it does.
- Follow [engineering judgment](.agents/references/engineering-judgment.md) and the applicable [implementation](.agents/skills/implement/SKILL.md), [review](.agents/skills/review/SKILL.md), and [audit](.agents/skills/codebase-audit/SKILL.md) workflows. Required architectural predecessors land separately from dependent features; incidental cleanup becomes a follow-up.
- For architectural work, state current and target ownership, dependency direction, affected persistent/wire formats, removal scope, and acceptance evidence before editing. Report what was verified and any remaining gaps. Do not use green tests to justify a boundary that violates this contract.
- Treat agent handoff briefs as investigation leads, not authority over owner decisions or evidence that a fix landed. Verify claims against the current revision and behavior. Keep volatile ports, worktree/stash status, test counts, and unverified implementation claims out of permanent architectural rules. A merged branch or a handoff cleanup suggestion is not permission to delete worktrees, stashes, keys, or local data.
- The [wallet messaging recovery plan](docs/plans/wallet-messaging-baseline/README.md) records the current proposed remediation sequence and ticket contracts. Its draft status, dependencies and scope mutexes must be resolved before dispatch; it does not override these invariants or authorize every proposed implementation.
