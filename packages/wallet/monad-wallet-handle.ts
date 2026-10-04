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
import type { MonadWalletPersistenceBundle } from './storage/monad-wallet-bundle'
import type { MonadCanonicalRoleOwner } from './monad-wallet-material'

export interface MonadWalletHandle {
  /** Explicit typed-root capability; absent until canonical composition is activated. */
  canonicalRoles?: MonadCanonicalRoleOwner
  pool: MonadSubAccountPool
  leaseManager: SubAccountLeaseManager
  provider: Provider
  httpClient: MonadTxSubmitter
  /** HD change branch used to recover the unused balance from confirmed, single-use payment
   * accounts. Optional for narrow tests and external callers that have not wired persistence yet;
   * `MonadChain.createWallet` always supplies it from the same seed as `pool`. */
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
export interface PublicRevisionZeroProcess {
  readonly processId: string
  readonly origin: string
  readonly tuple: RelayBinding
}
export interface PublicRevisionZeroInput {
  readonly networkTag: 'MONT' | 'MON1'
  readonly network: string
  readonly chainId: bigint
  readonly issuedAt: Timestamp
  readonly expiresAt: Timestamp
  readonly now: Timestamp
  readonly relayA: PublicRevisionZeroProcess
  readonly relayB: PublicRevisionZeroProcess
  readonly subjectBinding: 'A' | 'B'
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
