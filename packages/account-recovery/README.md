# `@frank/account-recovery`

This package owns Frank's transient Codex32 signup and recovery ceremonies. It
composes `@frank/codex32` with the frozen `@frank/domain-roots` registry and
does not depend on Vue, Pinia, a storage backend, BIP-39, or a chain SDK.

Signup parameters are explicit: the caller chooses the threshold, identifier,
share indices, and CSPRNG. The ceremony returns encoded threshold shares but
does not activate an account until the caller supplies an exact threshold set
that reconstructs the complete canonical 103-symbol payload generated for that
ceremony. It never creates or exposes an encoded Codex32 `s` secret.

Recovery validates the Frank `R || V` master record before deriving the five
purpose-tagged v1 domain roots. Callers own those returned byte arrays and must
wrap them using the approved platform vault before persistence, then call
`destroyAccountDomainRoots` when their in-memory ownership ends.

This is not a storage or UI package. It does not choose a default k-of-n policy,
authenticate the public recovery descriptor, encrypt resident roots, or make a
production-custody claim. Those remain integration and security-review gates.
