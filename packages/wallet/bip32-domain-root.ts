import { HDNodeWallet } from 'ethers'

export type Bip32DomainRootPurpose = 'evm-wallet' | 'identity-authentication'

/** Registry-derived bytes tagged with the only purpose this constructor may consume. */
export interface Bip32DomainRoot<
  Purpose extends Bip32DomainRootPurpose = Bip32DomainRootPurpose,
> {
  readonly purpose: Purpose
  readonly bytes: Uint8Array
}

/**
 * Constructs the BIP-32 master for an already-derived, purpose-tagged domain root.
 *
 * The domain-root registry owns recovery derivation and domain separation. Callers pass its
 * domain output here, never a recovery master payload or account root. This lower-level helper
 * preserves the domain bytes' BIP-32 interpretation; it does not derive an account or domain root.
 */
export function bip32MasterFromDomainRoot(
  domainRoot: Bip32DomainRoot,
  expectedPurpose: Bip32DomainRootPurpose,
): HDNodeWallet {
  if (
    typeof domainRoot !== 'object' ||
    domainRoot === null ||
    !(domainRoot.bytes instanceof Uint8Array)
  ) {
    throw new Error('BIP-32 domain root must be bytes')
  }
  if (domainRoot.purpose !== expectedPurpose) {
    throw new Error(`Expected ${expectedPurpose} BIP-32 domain root`)
  }
  const snapshot = Uint8Array.from(domainRoot.bytes)
  if (snapshot.length < 16 || snapshot.length > 64) {
    snapshot.fill(0)
    throw new Error('BIP-32 domain root must contain 16 to 64 bytes')
  }
  try {
    return HDNodeWallet.fromSeed(snapshot)
  } finally {
    snapshot.fill(0)
  }
}
