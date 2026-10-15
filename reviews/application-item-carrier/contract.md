# P1: feature-owned application items

Coordinator-authored Tier-3 contract. Exact base `53cbe203af7b16debd12251d506f142c3f344a9a`; branch `refactor/application-item-carrier`. Implementation: integrate_swap_proofs, GPT-6.1 Sol medium. Root owns independent review/integration. Local candidate only: no push, merge, deployment, live funded execution or release-hold changes.

## Problem and accepted outcome

The existing type-27 plugin wire is generic, but `MessageItem` is a closed union and `MessageItemPlugin<TRaw>` requires its members. A new swap feature would otherwise require its schema to be enumerated in cashweb or unsafe casts. Provide one feature-neutral carrier and typed registration path so the upcoming swap plugin owns its schema without core feature dependencies.

Add `ApplicationMessageItem` to cashweb's union with discriminator `type: 'application'`, bounded string `itemType` identifying the plugin and `value: unknown`. Feature code owns validation and interprets `value` only after its validator succeeds. Keep built-in union members and their existing bytes unchanged. This is an earned extension seam for S5, not an extraction of every historical game.

The registry supports typed application registration with a feature-owned `read(unknown): T`, encoder, decoder receiving the EXISTING enclosing decode context, and preview. The application wrapper hydrates to its validated value; no provider, custody or generic signing capability is required for this pure path. Do not add speculative lifecycle hooks or a DI framework. Existing registration must continue to work.

Routing identity for an application carrier is its validated `itemType`; for existing items it is their existing discriminator. Centralize that rule and use it for registry encode/decode, hydration, previews/tallies and wire dispatch. A concrete approach is to allow `MessageItemPlugin<ApplicationMessageItem>.type` to be its registered identifier, while preserving literal discriminator typing for existing raw-item types. The exact internal implementation may be simpler if it preserves these constraints. No new `any`, feature casts or declaration-merging bypass.

Validate carrier identity before looking up or invoking a plugin; validate payload before invoking feature callbacks. Reject duplicate registrations across both paths. Decoders must return the same registered identity. An application wrapper must not masquerade as a dedicated, self-only or not-carried historical item to bypass the existing wire rules. Reuse those rules; do not create another independent reserved-type table.

## Ownership, formats and removal scope

Cashweb owns only the neutral carrier. Registry owns dispatch/validation plumbing, codec owns existing frame/budget infrastructure, feature modules own their schemas. No import of swap/game implementations into cashweb or default wallet composition. Do not implement negotiation, funding, UI components or renderer registries here.

Wire type/schema/allocation and existing frame bytes do not change. Carrier persistence is a new local shape; plugin raw values must have a documented persistence-safe representation. Do not silently rely on JSON preserving bigint, typed arrays or prototypes. No migrations, dual readers or data reset. Unknown plugin frames remain exact unsupported bytes; malformed known payloads never execute; aggregate budget exhaustion rejects the message.

Allowed paths: `packages/cashweb/types/messages.ts`; `packages/wallet/message-item-plugins/registry.ts`, `wire.ts`, their existing Jest tests, `decoder-limits.jest.test.ts`, `default-registry.jest.test.ts`; optionally one focused pure `application-item.ts` and test beside registry; `packages/wallet/chain/canonical-item-roundtrip.jest.test.ts`; evidence in this directory. The default-registry test may recognize `application` as a neutral carrier rather than an installed feature; do not weaken built-in exhaustiveness or install a production default plugin. Report additional necessary paths before editing. No default registry installs or app/bot production changes in this predecessor.

## Acceptance

Use a test-owned plugin whose value type appears nowhere in the core union. Prove typed registration and canonical encrypted send/receive in both directions, feature value validation and preview/hydration, duplicate identifier rejection, wrong returned identity rejection, malformed/unknown retention, dedicated/self-only/not-carried rule preservation, and shared aggregate decoder budgets. Test two distinct application identifiers so routing cannot collapse to `'application'`. Include a persistence-shaped round trip for its raw JSON-safe carrier.

Run focused registry/wire/decoder/canonical-roundtrip suites and all configured `yarn typecheck:fast` projects. Existing built-in message behavior must remain equivalent. No expensive native-chain proofs need rerunning for this pure boundary. Required follow-up S5 installs its plugin in app/bot; later S7 adds an explicit component-renderer facade. This candidate cannot claim either outcome complete.

Reversal removes the new registration/carrier path and leaves existing wire items intact; received new plugin identifiers then remain unsupported. Never delete stored messages or wallets. A broader registry relocation or complete legacy feature extraction is out of scope.
