import en from '../i18n/en-us'
import fr from '../i18n/fr-fr'
import type { HtlcSwapView } from '@frank/swap-protocol/src/htlc-swap-runner'
/** Every phase a runner view can carry; the type makes a new phase fail here until labelled. */
const RUNNER_PHASES: Record<HtlcSwapView['phase'], true> = {
  offered: true,
  offerReceived: true,
  rejected: true,
  expired: true,
  accepted: true,
  xecLockPending: true,
  xecLocked: true,
  claiming: true,
  claimed: true,
  claimedByPeer: true,
  awaitRefund: true,
  awaitXecLock: true,
  locking: true,
  evmLocked: true,
  claimingXec: true,
  complete: true,
  lostToRefund: true,
  abandoned: true,
  refunding: true,
  refunded: true,
  invalid: true,
  unsupported: true,
  checking: true,
}
/** Dynamic state labels are a finite part of the app-owned facade, not arbitrary wire strings. */
test.each([
  ['en', en.signedSwap],
  ['fr', fr.signedSwap],
])(
  '%s contains every reachable dynamic negotiation label',
  (_name, messages) => {
    const labels = messages as typeof en.signedSwap
    for (const key of [
      'restoring',
      'scanning',
      'ready',
      'unsupported',
      'incomplete',
      'capacity',
      'storage-error',
      'awaitingAdmission',
      'conflict',
      'expired',
      'offered',
      'accept',
      'reject',
    ])
      expect(labels.states).toHaveProperty(key)
    for (const key of [
      'capacity',
      'expired',
      'conflict',
      'invalidAmount',
      'invalidIntent',
      'sessionChanged',
      'storage',
      'deliveryPending',
      'failed',
    ])
      expect(labels.errors).toHaveProperty(key)
    for (const key of ['confirmed', 'pending', 'payment-pending', 'error'])
      expect(labels.deliveryStates).toHaveProperty(key)
    for (const key of ['claimed', 'signed'])
      expect(labels.phases).toHaveProperty(key)
    for (const key of ['offer', 'accept', 'reject'])
      expect(labels.actions).toHaveProperty(key)
    // Every phase, warning and failure the session's swap runner can publish.
    for (const key of Object.keys(RUNNER_PHASES))
      expect(labels.execution.phases).toHaveProperty(key)
    for (const key of [
      'claim-gas-low',
      'xec-double-funded',
      'xec-foreign-output',
    ])
      expect(labels.execution.warnings).toHaveProperty([key])
    for (const key of [
      'storage-unavailable',
      'account-unavailable',
      'wallet-unavailable',
      'old-execution-records',
    ])
      expect(labels.execution.failures).toHaveProperty([key])
    for (const key of ['acceptBy', 'lockExpires'])
      expect(labels.deadlines).toHaveProperty(key)
  },
)
