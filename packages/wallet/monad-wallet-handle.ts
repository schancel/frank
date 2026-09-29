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
import type { MonadWalletPersistenceBundle } from './storage/monad-wallet-bundle'

export interface MonadWalletHandle {
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
  /** Complete wallet-owned persistence authority. Production stamp composition supplies this so
   * pools and journals cannot be assembled from unrelated roots. */
  walletState?: MonadWalletPersistenceBundle
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` -- each client
   * trims its own trailing slash, so this may or may not have one. */
  relayBaseUrl: string
}

const COMPLETE_STAMP_WALLET = Symbol('complete-stamp-wallet')

/** Opaque stamped-send authority. Component references are deliberately absent: the client must
 * derive every persistence dependency from the one branded bundle. */
export interface MonadStampWalletHandle {
  readonly [COMPLETE_STAMP_WALLET]: true
  readonly walletState: MonadWalletPersistenceBundle
  readonly provider: Provider
  readonly httpClient: MonadTxSubmitter
  readonly relayBaseUrl: string
}

export function createMonadStampWalletHandle(params: {
  walletState: MonadWalletPersistenceBundle
  provider: Provider
  httpClient: MonadTxSubmitter
  relayBaseUrl: string
}): MonadStampWalletHandle {
  if (params.walletState.durability !== 'persistent') {
    throw new Error(
      'Production Monad stamped sends require a durable complete wallet bundle'
    )
  }
  return { ...params, [COMPLETE_STAMP_WALLET]: true }
}

/** Explicitly unsafe composition seam for isolated unit tests only. Production code must use
 * `createMonadStampWalletHandle`, which rejects ephemeral or separately threaded components. */
export function unsafeCreateMonadStampWalletHandleForTests(
  params: MonadWalletHandle
): MonadStampWalletHandle {
  if (params.stampAttemptJournal === undefined) {
    throw new Error(
      'Monad stamped sends require a crash-safe stamp-attempt journal'
    )
  }
  const walletState =
    params.walletState ??
    ({
      durability: 'test-only-ephemeral',
      pool: params.pool,
      leaseManager: params.leaseManager,
      changePool: params.changePool,
      stampAttemptJournal: params.stampAttemptJournal,
      stampPaymentJournal: params.stampPaymentJournal,
      assertNoOrphanedLeases: () => undefined,
      assertSemanticallyValid: () => undefined,
      repairAttemptSpendLifecycles: async () => undefined,
      reconcileRestoreState: async () => undefined,
    } as unknown as MonadWalletPersistenceBundle)
  if (
    walletState.pool !== params.pool ||
    walletState.leaseManager !== params.leaseManager ||
    walletState.changePool !== params.changePool ||
    walletState.stampAttemptJournal !== params.stampAttemptJournal ||
    walletState.stampPaymentJournal !== params.stampPaymentJournal
  ) {
    throw new Error(
      'Monad wallet components do not belong to one persistence bundle'
    )
  }
  return {
    [COMPLETE_STAMP_WALLET]: true,
    walletState,
    provider: params.provider,
    httpClient: params.httpClient,
    relayBaseUrl: params.relayBaseUrl,
  }
}

export function isMonadStampWalletHandle(
  value: unknown
): value is MonadStampWalletHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Partial<MonadStampWalletHandle>)[COMPLETE_STAMP_WALLET] === true
  )
}
