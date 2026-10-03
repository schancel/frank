import { HDNodeWallet } from 'ethers'

export type MonadDomainRootPurpose = 'evm-wallet' | 'identity-authentication'

/** Candidate registry output tagged with the only purpose this constructor may consume. */
export interface MonadDomainRoot<
  Purpose extends MonadDomainRootPurpose = MonadDomainRootPurpose,
> {
  readonly purpose: Purpose
  readonly bytes: Uint8Array
}

/**
 * Constructs the BIP-32 master used by one already-derived Monad domain.
 *
 * This is deliberately below Frank's recovery derivation registry: callers must pass the output
 * assigned to this domain, never the Codex32 master payload or account root. This helper preserves
 * the existing BIP-32 interpretation; it does not approve that interpretation for the recovery
 * registry. The registry remains a separate blocking decision and must freeze this algorithm (or
 * replace this unused seam), its exact output length, and vectors before production signup.
 */
export function monadMasterFromDomainRoot(
  domainRoot: MonadDomainRoot,
  expectedPurpose: MonadDomainRootPurpose,
): HDNodeWallet {
  if (
    typeof domainRoot !== 'object' ||
    domainRoot === null ||
    !(domainRoot.bytes instanceof Uint8Array)
  ) {
    throw new Error('Monad domain root must be bytes')
  }
  if (domainRoot.purpose !== expectedPurpose) {
    throw new Error(`Expected ${expectedPurpose} Monad domain root`)
  }
  const snapshot = Uint8Array.from(domainRoot.bytes)
  if (snapshot.length < 16 || snapshot.length > 64) {
    snapshot.fill(0)
    throw new Error('Monad domain root must contain 16 to 64 bytes')
  }
  try {
    return HDNodeWallet.fromSeed(snapshot)
  } finally {
    snapshot.fill(0)
  }
}
