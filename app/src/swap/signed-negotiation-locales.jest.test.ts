import en from '../i18n/en-us'
import fr from '../i18n/fr-fr'
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
  },
)
