# Draft: [design] Specify explicit reset scope and recovery-preserving lifecycle

Status: NEEDS_SPECIFICATION. Owner: coordinator/root with maintainer policy acceptance. No implementation, claim or publication. Read-only source evidence; no reset or owner profile accessed.

## Evidence

Root is intentionally held at aabb5688f7a04379d49a3f3732d66f3ef5a5b84f. Read-only comparison also inspected frozen BIP39 containment candidate d09fcf1d396f66823b70c2bb6ba35cb4f42d7235; this is candidate evidence, not a claim that it landed.

- Setup.vue shows “Reset storage” when account/legacy storage is locked or unavailable. Its resetStorage handler obtains confirmation before calling accountSession.reset. At held root it uses window.$t with an English fallback; the containment candidate uses the component translator and updates EN/FR copy to say BIP39 import remains unavailable. Both prompts describe clearing unopenable local account data; neither enumerates other accounts’ wallet/recovery databases.
- session.ts:735 reset invalidates the current generation, clears published account/pending references, closes the current wallet/custody and calls resetAccountStorage. It then notifies/reopens. Explicit reset remains independent from import; containment removes the automatic import invocation, not this deliberate action.
- resetAccountStorage(namespace='local-account-v1'):761 always selects the two exact custody/vault namespace databases. If indexedDB.databases is available, it also selects every same-origin database whose name starts with frank- or contains monad-wallet-state or level-js, regardless of the namespace argument. Thus the parameter scopes the two initial names, not the enumerated deletion set.
- Custody/vault database names contain their namespace; EVM wallet storage uses a configured prefix plus identity/economic-account storageKey (monad-chain.ts:1537–1544). A prefix match alone does not establish which active account owns each selected database. The existing reset test at session.jest.test.ts:520 explicitly expects deletion of custody, vault, wallet-state and a level-js manifest; it excludes a nonmatching unrelated database. Setup’s test mocks confirmation as true and reset as a spy.
- Every deleteDatabase request resolves on success and error; blocked deletion resolves after300ms, and synchronous errors also resolve. Enumeration failures silently leave only the initial pair. The API does not return a per-store deletion outcome. This is a source observation, not proof of actual partial deletion.

This is a broad matching-database action within one origin, not all browser/profile data: it does not enumerate other origins or clear all localStorage. An explicitly authorized broad reset may be intended. This draft does not decide that deletion is always forbidden or choose a new “safe” selector.

## Decisions required before a ready contract

1. What does Reset mean: current account, named custody namespace, all Frank accounts on this origin, or another explicitly disclosed scope? How should confirmation identify affected namespaces/records and distinguish recoverable caches from wrapped keys and financial evidence?
2. What policy applies to funded accounts and exposed/ambiguous payments, reservations, public custody provenance and delivery/recovery journals? What backup/reconciliation or separate retirement authority is required, if any? A deletion cannot itself prove nonexecution or authorize a new payment. Do not equate a key backup with backup of exact operation evidence.
3. Which existing owner can map selected databases to an account/network/namespace, including damaged records? How should unknown, unopenable or unrelated same-origin matching names be treated? No namespace registry or migration is prescribed here.
4. Which wallet/tasks/tabs must quiesce before deletion, and what happens if another connection blocks it? How should canceled confirmation, denied enumeration, partial failure and late deletion be reported and retried without claiming a fresh successful reset prematurely?
5. After an accepted reset, what exact state may reopen and what records must remain for future recovery? Freeze interruption/restart behavior and cross-account isolation before implementation; do not infer authority from a locked/unavailable status.

## Acceptance for the design, not implementation

Record the chosen scope, precise user consent, each durable fact’s owner and deletion/retention authority, failure/restart outcomes and affected paths. Then author a separate bounded Tier3 implementation contract and synthetic namespace/blocked/partial-failure regressions. No owner data or live funds are needed. General explicit reset remains callable until the maintainer chooses its policy; this draft grants no mutation rights.

## Dedupe

Fresh open/recent searches for reset/storage deletion/scope found no open exact policy owner. #1280 explicitly excludes general reset deletion policy. Closed #1085 introduced explicit recovery/reset options; closed #1089 expanded deletion; closed #1151 concerns the now-contained automatic import reset. #1279 protects message-store read-only operations and #1230 retains financial recovery; neither specifies user-authorized reset breadth. Suggest a distinct design follow-up linked to #1280/#1230, not a claim that either is incomplete because it left this separate policy unchanged.
