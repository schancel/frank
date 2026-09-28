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
import { StampPaymentJournal } from './storage/stamp-payment-journal'
import { StampAttemptJournal } from './storage/stamp-attempt-journal'

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
  /** Base URL of the `cashweb-registry` relay, e.g. `https://relay.example.com` -- each client
   * trims its own trailing slash, so this may or may not have one. */
  relayBaseUrl: string
}
