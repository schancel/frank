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
