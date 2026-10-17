# P1 application-item carrier evidence

Base: `53cbe203af7b16debd12251d506f142c3f344a9a`. Coordinator-authored Tier-3 contract: [contract.md](contract.md). Implementation lane requested/dispatched: GPT-6.1 Sol medium. This is a local candidate for independent review; the breaking-release hold remains in place.

## Result and ownership

Cashweb now owns one feature-neutral `ApplicationMessageItem` carrier (`type: 'application'`, `itemType`, `value: unknown`). It enumerates no new swap or game schema. The registry's `registerApplication<T>` bridge accepts the feature's validator, encoder, decoder and preview. Hydration returns that feature's validated value without needing a provider or custody capability. Existing registration remains available.

`messageItemType` centralizes routing: application items use their validated plugin identifier; existing items retain their discriminator. Registration, encode/decode, hydration, previews/tallies and wire dispatch preserve that identity. A registration's carrier marker survives copying registrations into another registry. The typed bridge uses no new `any` or feature casts.

Existing wire rules are reused to reject an application carrier claiming a dedicated-frame, self-only or not-carried historical identifier, even for self-addressed messages. Receive checks this restriction before invoking the application's decoder. Duplicate identifiers collide across both registration paths, and a decoder returning another identity fails.

Raw carrier values use a documented JSON-safe representation. Runtime validation rejects bigint, typed arrays, non-finite numbers/negative zero, undefined, custom object/array prototypes (including inherited `toJSON`), functions, accessors, symbol/nonenumerable properties, sparse arrays and cycles. Large integers and binary fields must use the feature's explicit string representation. This checks local persistence shape; it does not replace or restart the enclosing CBOR decoder budget. No migration, dual reader or data deletion was added.

Type 27/schema1/min-reader1 and all existing built-in wire formats remain unchanged. No production plugin installation, UI change, swap negotiation, signing session, funding or financial-runtime consumer was introduced. S5 feature composition and S7 component-renderer work remain separate.

## Boundary regression and verification

The test-owned `Note`/`Label` schemas appear only in tests, never in the core item union. Two independently named applications round-trip through the real canonical encrypted send/fetch path in both directions using the existing offline two-wallet fixture. Coverage also exercises validation before callbacks, preview/hydration, copied registrations, persistence-shaped JSON round trips, duplicate/wrong identities, unknown/malformed exact-frame retention, reserved-rule rejection and aggregate decoder exhaustion.

The new swallowed-error regression initially failed: `encodeItemFrames` did not check its watched budget after readback when a decoder caught a resource exception. Receive already checked that flag. The correction adds the final send check to the same existing watched budget, uniformly across plugins. No budget is reset or duplicated. Initial evidence: `/tmp/frank-p1-application.log` and `/tmp/frank-p1-focused.log`; final pass: `/tmp/frank-p1-focused-final.log`.

The default-registry test still exhaustively covers every built-in type. It recognizes `application` as a carrier rather than an installed feature, and its dependency assertion permits only the new pure helper alongside the existing registry/wire boundary. Coordinator explicitly approved this necessary test-path adjustment and updated the contract.

| Final gate | Result |
| --- | --- |
| Application, registry, wire, decoder-limit, default-registry and canonical-roundtrip suites | 6 suites; 1080/1080 pass |
| All configured `yarn typecheck:fast` projects | 23/23 pass |
| Changed/new wallet source and tests, app Prettier configuration | Pass |
| `git diff --check` | Pass |
| Optional cashweb messages.ts whole-file app-formatter probe | Inherited failure, reproduced on exact base |

Final commands:

```sh
yarn --cwd packages/wallet test --runInBand message-item-plugins/application-item.jest.test.ts message-item-plugins/registry.jest.test.ts message-item-plugins/wire.jest.test.ts message-item-plugins/decoder-limits.jest.test.ts message-item-plugins/default-registry.jest.test.ts chain/canonical-item-roundtrip.jest.test.ts
yarn typecheck:fast
node_modules/.bin/prettier --config app/.prettierrc.json --check packages/wallet/message-item-plugins/application-item.ts packages/wallet/message-item-plugins/application-item.jest.test.ts packages/wallet/message-item-plugins/registry.ts packages/wallet/message-item-plugins/wire.ts packages/wallet/message-item-plugins/default-registry.jest.test.ts packages/wallet/chain/canonical-item-roundtrip.jest.test.ts
git diff --check
```

Logs: `/tmp/frank-p1-focused-final.log`, `/tmp/frank-p1-typecheck-final.log`, `/tmp/frank-p1-format-check.log`. The optional cashweb formatting probe is `/tmp/frank-p1-cashweb-format.log`; its exact-base comparison used `/tmp/frank-p1-messages-before.ts`. Cashweb has no configured package formatting script; no whole-file cleanup or all-affected-files formatting pass is claimed.

Dependencies used owned candidate-local overlays pointing to existing installed external packages. All @frank workspace links targeted this checkout; wallet Chronik4.3.1 was verified. No manifests/lockfiles/install/download changed. After all gates finished, only these owned overlays and generated local caches were removed. No native/live/funded-chain experiment, publication, push, merge or deployment occurred.
