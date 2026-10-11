# Historical Frank BIP39 recovery

The owner requires restoration of existing Frank BIP39 accounts. A phrase is an
existing root secret, not permission to create a different account. The importer
removed in `1b3108756cb2625d0098bc455e56bcee0985e35d` hashed phrase and path into a
new account root, so reverting it does not satisfy this request.

## Required custody predecessor

Current ownership: `@frank/account-vault` encrypts a 32-byte Codex32 account root;
app custody authenticates its public recovery descriptor and coordinates staging
and activation. The app session derives typed domain roots, constructs the wallet,
and publishes readiness. Wallet material owns identity, spend/change derivation,
and signing. Historical BIP39 wallet material exists, but it cannot pass current
typed custody and canonical messaging admission.

Target ownership stays the same. Introduce an explicit historical BIP39 secret
variant in the existing vault and custody operations. Store the exact 64-byte
BIP39 PBKDF2 seed encrypted with a public derivation discriminator. Never hash,
truncate, or reinterpret it as a Codex32 root or a typed HKDF domain root. Public
account metadata must bind that variant to the recovered identity, without
claiming a Codex32 descriptor exists. The exact active-revision precondition,
intent journal, interruption/reopen behavior, and explicit activation remain.

The existing Codex32 plaintext, descriptors, derivation, and backup writer remain
unchanged. The historical variant has its own authenticated plaintext framing and
public receipt context. These are two supported derivations, not old/new readers
for one format. No migration or automatic reset is part of recovery. Historical
seed material must be copied before awaits, wiped after use, and never enter
reactive public state or logs. Codex32 backup must explicitly reject the historical
variant rather than silently export a different root.

The session receives owned typed material through public custody operations and
selects wallet composition from its recorded derivation. It must reject invalid,
missing, closed, or replaced material before readiness; no empty-state success.

## Identity and mailbox contract

Historical Frank identity is `m/44'/60'/1'/0/0` beneath the BIP39 PBKDF2 seed.
Spending uses `m/44'/60'/0'/0/*`; change uses `m/44'/60'/0'/1/*`. Restore must match
the historical identity public/private key, pool keys, and change keys exactly.
This request is historical Frank recovery, not arbitrary external-account import.

Canonical messaging currently requires scoped auth/message/stamp role capabilities
that historical wallet material does not supply. The role-key module reserves auth
at the same identity path, message at `m/44'/60'/4'/0'/g'`, and stamp at
`m/44'/60'/2'/0'/g'`. Extending composition must preserve the historical identity
and the actual mailbox decryption keys. The first feature candidate restores custody, historical wallet keys, profile, and
current canonical messaging. Historical envelope retrieval is a separate required
stack if the removed transport needs reconstruction; this candidate must not claim
that restoring keys retrieves old envelopes. The historical mailbox reader boundary
needs independent review; an invented conversion or identity-key fallback
inside canonical transport does not establish preservation.

## Feature and acceptance

Validate and normalize the user's BIP39 phrase in memory, derive the established
seed, stage through public custody, show the recovered identity, and activate
explicitly. Do not require a display name. Required application restoration must
finish before session readiness, so messaging cannot publish a stale device
profile during recovery. Fetch the recovered identity's published profile without
writing: reuse an existing valid profile; missing or expired means profile setup;
relay failure stays visible and retryable with recovered custody retained.

Acceptance includes synthetic known-phrase equivalence, public session
activation/reopen, exact spend/change/identity key equality, mailbox decryption,
wrong-material and stale-session rejection, interruption/retry, unchanged
Codex32 backup/restore, and profile existing/missing/expired/network-failure cases.
Required-restoration failure must gate wallet acquisition, messaging, and route
effects. No live funding or private user phrase is needed for these checks.

Stack order: custody/material predecessor, independently reviewed; then BIP39
recovery UI/session integration and its production-boundary regressions. The
no-name and profile-restoration correction can be reviewed independently.
