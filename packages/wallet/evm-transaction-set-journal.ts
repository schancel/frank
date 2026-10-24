/** Mutation capability for the shared preparer; the bundle retains the raw journal owner. */
import { captureNativeInputSelection, nativeAdmissionJournal } from './evm-input-admission'
import type { EvmTransactionSetJournal } from './evm-transaction-set-types'
import type { EvmWalletPersistenceBundle } from './storage/evm-wallet-bundle'

export function evmTransactionSetJournal(
  owner: EvmWalletPersistenceBundle,
): EvmTransactionSetJournal {
  const reader = owner.nativeJournal
  if (!reader)
    throw new Error('Transaction sets require a bound native journal')
  return {
    binding: reader.binding,
    captureInputSelection: () => owner.runLifetime(async lifetime =>
      captureNativeInputSelection(owner.inputAdmission, lifetime)),
    list: () => reader.list(),
    get: id => reader.get(id),
    canSelect: (account, nonce) => reader.canSelect(account, nonce),
    prepare: (plan, signed) =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(owner.inputAdmission, lifetime).prepare(
          plan,
          signed,
        ),
      ),
    authorizeTransactionSet: (id, expected) => owner.runLifetime(lifetime =>
      nativeAdmissionJournal(owner.inputAdmission, lifetime).authorizeTransactionSet(id, expected)),
    appendTransactionSet: (id, stage, members, signed) => owner.runLifetime(lifetime =>
      nativeAdmissionJournal(owner.inputAdmission, lifetime).appendTransactionSet(id, stage, members, signed)),
    refreshPreparation: id =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(
          owner.inputAdmission,
          lifetime,
        ).refreshPreparation(id),
      ),
    markExposed: (id, index) =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(owner.inputAdmission, lifetime).markExposed(
          id,
          index,
        ),
      ),
    markSyncApplied: (id, index) =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(owner.inputAdmission, lifetime).markSyncApplied(
          id,
          index,
        ),
      ),
    markTransactionSetInventoryApplied: (id, index) =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(
          owner.inputAdmission,
          lifetime,
        ).markTransactionSetInventoryApplied(id, index),
      ),
    discardUnexposed: id =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(owner.inputAdmission, lifetime).discardUnexposed(id),
      ),
    beginCapture: (id, index) =>
      owner.runLifetime(async lifetime =>
        nativeAdmissionJournal(owner.inputAdmission, lifetime).beginCapture(
          id,
          index,
        ),
      ),
    recordObservation: (...args) =>
      owner.runLifetime(lifetime =>
        nativeAdmissionJournal(
          owner.inputAdmission,
          lifetime,
        ).recordObservation(...args),
      ),
  }
}
