# `@frank/swap-protocol`

Experimental, testnet-only Stage-0 atomic-swap protocol core. It implements the specification's
exact v1 coordination-event bytes, domain-separated hashes, sender hash chains, bounded event
budgets, prerequisite ordering, deterministic semantic reduction, and conservative cancel cutoff.

`advanceStage0` is a deterministic fake-adapter lifecycle model for preparation gates, local
authorization cutoffs, funding/reveal readiness, custody-mode-specific settlement, restart, and
explicit recovery outcomes. It consumes facts that a caller has already authenticated or observed;
it does not turn peer reports into chain authority.

It deliberately does not allocate message type IDs or payload schemas. A pair manifest supplies
those values, authorized producers, canonical payload interpretation, and state transitions. It
also does not sign transactions, broadcast, persist secrets, watch chains, or claim recoverable
atomic settlement. Those remain separate typed boundaries in `docs/atomic-swap-specification.md`.
