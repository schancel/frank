/**
 * The shared constructor shape `MonadStampClient` (`./monad-stamp-client.ts`, #13),
 * `MonadTopicPostClient` (`./monad-topic-post-client.ts`, #31), and `MonadTopicVoteClient`
 * (`./monad-topic-vote-client.ts`, #32) all take -- a real, if unplanned, shared shape ticket #41
 * found while building `../chain/monad-chain.ts` and formalized here per that ticket's own
 * acceptance criteria, rather than three separate inline object literals.
 *
 * Purely additive/mechanical: giving this shape a name changes no behavior in any of the three
 * client files above -- each already declared exactly these five fields, in this exact shape, in
 * its own `constructor` parameter type before this ticket.
 */
import { Provider } from 'ethers'

import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import { MonadChangePool } from './monad-change-pool'
import type { StampPaymentJournal } from './storage/stamp-payment-journal'
import type { StampAttemptJournal } from './storage/stamp-attempt-journal'
import type { TopicOperationJournal } from './storage/topic-operation-journal'
import type {
  MonadWalletPersistenceBundle,
  MonadWalletOperationAdmission,
} from './storage/monad-wallet-bundle'
import type { MonadCanonicalRoleOwner } from './monad-wallet-material'
import type { MonadStealthKeyring } from './monad-stealth'
import type { MonadIdentity } from './monad-identity'

import type { AccountHygieneEngine } from './account-hygiene'
import type { MonadAddressInventory } from './monad-address-inventory'
import type { ChainUtxoPool, AccountUtxoPool } from './chain-utxo-pool'

export interface MonadWalletHandle {
  /** Master / author identity for signing messages and topic posts. */
  identity?: MonadIdentity
  /** Explicit typed-root capability; absent until canonical composition is activated. */
  canonicalRoles?: MonadCanonicalRoleOwner
  /** Keyring tracking discovered stealth accounts and spend keys. */
  stealthKeyring?: MonadStealthKeyring
  /** Private active delegation from the existing owner; structural values are rejected. */
  walletOperationAdmission?: MonadWalletOperationAdmission
  /** Autonomous account hygiene and lazy dirty sweeper (Ticket #925). Encapsulated beneath the wallet API. */
  hygieneEngine?: AccountHygieneEngine<string>
  /** Unified HD address inventory tracking spend and change branches (Ticket #924). */
  inventory?: MonadAddressInventory
  /** Unified in-memory UTXO and spendable account pool (Issue #1184). */
  accountUtxoPool?: ChainUtxoPool
  /** @deprecated Use `accountUtxoPool` instead. */
  pool: MonadSubAccountPool
  leaseManager: SubAccountLeaseManager
  provider: Provider
  httpClient: MonadTxSubmitter
  /** HD change branch used to recover the unused balance from confirmed, single-use payment
   * accounts. Optional for narrow tests and external callers that have not wired persistence yet;
   * `MonadChain.createWallet` always supplies it from the same seed as `pool`.
   * @deprecated Use `accountUtxoPool` instead. */
  changePool?: MonadChangePool
  /** Durable public journal of recipient-owned one-time stamp outputs and their sweep state. */
  stampPaymentJournal?: StampPaymentJournal
  /** Durable exact raw payment sets awaiting a definitive relay success. */
  stampAttemptJournal?: StampAttemptJournal
  /** Exact byte authority for crash-replayable topic posts and votes. */
  topicOperationJournal?: TopicOperationJournal
  /** Complete wallet-owned persistence authority. Production stamp composition supplies this so
   * pools and journals cannot be assembled from unrelated roots. */
  walletState?: MonadWalletPersistenceBundle
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` -- each client
   * trims its own trailing slash, so this may or may not have one. */
  relayBaseUrl: string
  /** Explicit Frank-CBOR network identifier. Canonical Forum operations require it. */
  cborNetwork?: string
  /** Exact canonical Forum economic policy; required by paid Forum operations and replay. */
  forumBurnAddress?: string
  forumChainId?: bigint
}

/** Present only on the private wallet-owner facade, never inferred from a normal legacy handle. */
export interface MonadCanonicalWalletHandle extends MonadWalletHandle {
  walletState: MonadWalletPersistenceBundle
  canonicalRoles: MonadCanonicalRoleOwner
  installedNetworkTag: 'MONT' | 'MON1'
  runCanonicalExclusive<T>(operation: () => Promise<T>): Promise<T>
}

import type { Timestamp, RelayBinding } from '@frank/codec'
import type { RolePoint } from '../role-keys/src'
/**
 * What an account signs into its own directory entry: the one relay it lives on and how long the
 * entry is valid. The relay tuple is the one that relay publishes at `/relay/v1/info`.
 */
export interface PublicRevisionZeroInput {
  readonly networkTag: 'MONT' | 'MON1'
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
  readonly networkTag: 'MONT' | 'MON1'
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
