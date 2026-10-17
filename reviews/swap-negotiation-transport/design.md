# S5b: inert negotiation transport direction

Root design for the immediate successor of reviewed S5a; not a dispatch packet until its exact base and worktree are frozen. S5a is currently under corrective review, including verified Buffer snapshot repairs. Existing P1 carrier and shared decoder-budget checks are predecessors. S5c will own authenticated runtime ingestion and its durable journal; no runtime callback is needed merely to install inert transport.

## Wire and projection

Install feature-owned item identifier `swap-negotiation-v1` in the existing type-27/schema-1/min-reader-1 application carrier. No new central protocol allocation. The JSON projection is exactly `{ eventHex: string }`, lowercase even-length canonical hex bounded by twice S5a's event-byte limit. Signed event bytes remain authoritative; never duplicate mutable amount, party, status or settlement fields into the carrier.

The separate `packages/swap-protocol/src/message-plugin.ts` entry exposes a structural application-plugin descriptor. It uses S5a's schema/self-contained-signature decoder under an explicitly supplied pair policy and enclosing `NestedItemBudget`. It imports no wallet runtime, Vue/Pinia, custody, bot framework or default registry. Its decode context needs only the existing budget capability. Core negotiation remains independently importable.

Local read validates exact projection shape and full schema/signature. Encode returns the original canonical event bytes without signing or changing terms. Decode performs one budgeted payload parse and returns the canonical projection. Hydration is inert. Preview is factual: Swap offer / Swap acceptance message / Swap rejection message. Preview and hydration never imply authenticated admission, current eligibility, funds locked or settled, and initiate no transitions, signatures, network requests or replies.

Preserve existing unsupported/malformed policy: missing plugin/unknown identifier retains exact unsupported frame; malformed known payload, including unsupported inner versions under the known identifier, follows existing malformed retention. Shared budget exhaustion rejects the whole message even if a plugin wraps the underlying exception. No new fallback JSON text, opaque-success category or alternative error policy.

## Explicit composition

App installs the descriptor in `app/src/utils/message-items.ts` using the actual initial testnet pair policy. No import side effects and no addition to wallet's default feature list. Bot-framework gains one optional registry factory at its existing registry installation point; it remains feature-agnostic. Concrete all-bots composition supplies a pure factory that creates existing defaults and registers this feature explicitly. Keep that factory separately importable so tests exercise the production composition without starting bots or altering log globals. Preserve current factory-default behavior for hosts not opting into this feature. Never import swap rules into generic transport, cashweb or custody.

Use testnet policy for actual app/bot composition. Local regtest proofs explicitly request their separately named proof policy; no chain alias or invented deployment. Other bot entrypoints remain explicitly unsupported unless separately installed; do not imply universal support from one target's registry.

## Acceptance and successor

Test actual app-composed and bot-composed registries through canonical encrypted send/receive in both directions, including Offer/Accept/Reject and response-before-offer. Use existing two-wallet harness and synthetic transport/funding fixtures; no live funded transactions. Round-trip JSON persistence preserves exact bytes. Test missing plugin, invalid signature/schema, unknown identifier/version and aggregate enclosing budget exhaustion. Prove hydrate/preview have no side effects and no signing capability. Test bot factory consumption at actual host installation, including visible factory failure and normal cleanup.

Whole-package tests, relevant existing P1 registry/wire integration gates and all configured typechecks are required. Dependency checks enforce pure feature/core boundaries. S5b does not provide authoritative negotiation state, funding approval, operation recovery or UI execution. S5c must bind canonical authenticated receive records to exact account/conversation/ordered parties, durably retain evidence, and only then apply reduction. Full swap delivery remains incomplete until the runtime and UI are proven.
