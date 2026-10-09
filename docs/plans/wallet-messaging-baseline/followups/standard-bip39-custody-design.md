# Draft: [design] Specify identity-preserving standard BIP39 custody import

Status: NEEDS_SPECIFICATION, not a promised feature or implementation dispatch. Owner: coordinator/root and maintainer. Draft only; no tracker mutation, custody activation, real phrase/profile, network or funding action.

## Outcome to specify

If standard BIP39 import is supported later, the selected account/path must correspond to the actual receive and signing authority activated in custody. Showing a scanner address while activating a different identity is not import. Keep pure local identification and explicit unavailable activation from #1280 until an accepted identity/custody contract exists.

Independent prior pure-source verification at1e8b652e used only the repository’s public synthetic vector and established that the old phrase/path-hash-to-domain-root conversion yields authentication/native-main addresses different from the selected candidate. No live account was activated and no funds loss was observed. The containment candidate removes that conversion; it does not implement standard import.

## Questions for owner acceptance

- Which BIP39 paths, networks and account/address roles are supported? What identity continuity must hold for receive/signing addresses, authentication, spend/change branches and messaging purposes? Do not reuse a standard legacy spending key for unrelated domain roles by assumption.
- What existing custody/vault representation can wrap and recover those selected keys/branches without inventing a hash-to-new-identity conversion? How are backup format, derivation version and path choices disclosed and proven on reopen?
- Is imported custody an independent account or an explicitly authorized replacement? How are pre-existing funded accounts, pending custody and retained operation journals preserved and isolated? No automatic reset, transfer, re-encryption or financial-history deletion follows from import consent.
- Which existing wallet adapter capabilities can consume that custody representation? What is explicitly unsupported? Existing createBip39WalletMaterial preserves a selected key in a lower-level seam, but its existence alone does not specify or authorize integration into account custody.
- What separate user-authorized workflow, if any, migrates funds/history or rotates identity? Import and migration are different outcomes; no transfer feature is implied.

## Design acceptance evidence

Freeze public selected-path vectors and prove the displayed selected address equals the actual activated receive/signing authority across restart. Specify relevant purpose separation, wrong-path/network rejection, backup/reopen behavior, staging/activation interruption, unchanged old-account state on failure, explicit replacement consent and zero unintended transactions. Produce a separate exact-path Tier3 contract and independent custody review before implementation. No changes to derivation or durable formats are pre-approved by this draft.

## Dedupe

Fresh BIP39/custody search found open #1280 containment, which explicitly excludes a correct import design. Closed #847 requests direct funded-seed access and deferred migration; it supplies product history, not a current ready custody contract. Closed #737 concerns explicit legacy funds/history transfer and is related, not equivalent to importing signing authority. Closed #1089 concerns the superseded typed-root path. Suggest a separate design follow-up linked to #1280/#847; do not reopen an old success implementation by inference.
