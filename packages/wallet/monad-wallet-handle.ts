import type { EvmWalletHandle } from "./evm-wallet-handle";
import type { MonadWalletPersistenceBundle } from "./storage/monad-wallet-bundle";
import type { MonadCanonicalRoleOwner } from './monad-wallet-material'

/** Present only on the private wallet-owner facade, never inferred from a normal legacy handle. */
export interface MonadCanonicalWalletHandle extends EvmWalletHandle {
  walletState: MonadWalletPersistenceBundle
  canonicalRoles: MonadCanonicalRoleOwner
  installedNetworkTag: 'MONT' | 'MON1' | 'MONR'
  runCanonicalExclusive<T>(
    operation: (
      lifetime: import('./storage/monad-wallet-bundle').MonadWalletOperationAdmission,
    ) => Promise<T>,
  ): Promise<T>
}

import type { Timestamp, RelayBinding } from '@frank/codec'
import type { RolePoint } from '../role-keys/src'
/**
 * What an account signs into its own directory entry: the one relay it lives on and how long the
 * entry is valid. The relay tuple is the one that relay publishes at `/relay/v1/info`.
 */
export interface PublicRevisionZeroInput {
  readonly networkTag: 'MONT' | 'MON1' | 'MONR'
  readonly network: string
  readonly chainId: bigint
  readonly issuedAt: Timestamp
  readonly expiresAt: Timestamp
  readonly now: Timestamp
  readonly relay: RelayBinding
}
/** A later revision of the same entry: a renewal, or a move to another relay. No key changes. */
export interface PublicNextRevisionInput extends PublicRevisionZeroInput {
  /** Revision being signed; the current head's revision plus one. */
  readonly revision: bigint
  /** T1 of the current head statement. */
  readonly predecessor: Uint8Array
}
export interface PublicRevisionZeroExport {
  readonly kind: 'public-revision-zero-preparation'
  readonly registry: 'frank-domain-roots-v1'
  readonly networkTag: 'MONT' | 'MON1' | 'MONR'
  readonly network: string
  readonly chainId: bigint
  readonly authAddress: string
  readonly auth: RolePoint<'auth'>
  readonly message: RolePoint<'message'>
  readonly stamp: RolePoint<'stamp'>
  readonly statement: Uint8Array
  readonly attestation: Uint8Array
  readonly t1: Uint8Array
  readonly configuration: PublicRevisionZeroInput
}
export interface PublicNextRevisionExport
  extends Omit<PublicRevisionZeroExport, 'kind' | 'configuration'> {
  readonly kind: 'public-next-revision-preparation'
  readonly revision: bigint
  readonly configuration: PublicNextRevisionInput
}
