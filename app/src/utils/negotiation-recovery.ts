import { shallowRef, readonly } from 'vue'
import {
  activeChain,
  type NativeWalletHandle,
  type WalletHandle,
} from '@frank/wallet/chain'
import { createBrowserNegotiationJournalStore } from '@frank/swap-protocol/src/storage/negotiation-browser'
import { appNegotiationIncarnation } from '@frank/swap-protocol/src/host-identity'
import {
  NegotiationRecovery,
  type NegotiationRecoverySnapshot,
} from '@frank/swap-protocol/src/runtime'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import type { PublicAccount } from '../accounts/custody'

const status = shallowRef<NegotiationRecoverySnapshot | null>(null)
let inspectCurrent: (() => NegotiationRecoverySnapshot) | undefined
/** Each inspection receives its own bytes; presentation cannot mutate future evidence. */
export const negotiationRecoveryStatus = readonly({
  get snapshot(): NegotiationRecoverySnapshot | null {
    // Reading the published ref subscribes Vue; the runtime rebuilds copied evidence.
    const published = status.value
    return published === null ? null : inspectCurrent?.() ?? published
  },
})
let current: object | undefined
/** Installed after directory admission; independent of chat storage and ordinary polling. */
export function startAppNegotiationRecovery(input: {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
}): { stop(): Promise<void> } {
  const mine = {}
  current = mine
  inspectCurrent = undefined
  const publish = (snapshot: NegotiationRecoverySnapshot) => {
    if (current === mine) status.value = snapshot
  }
  const chain = activeChain
  const messages = chain.directMessages
  const scanner = messages?.scanAuthenticatedMailbox
  if (
    chain.chainIdentifier !== TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    !scanner
  ) {
    publish({ state: 'unsupported', coverage: undefined, journals: [] })
    return {
      stop: async () => {
        if (current === mine) {
          current = undefined
          inspectCurrent = undefined
          status.value = null
        }
      },
    }
  }
  let recovery: NegotiationRecovery | undefined
  try {
    if (input.wallet.chainIdentifier !== chain.chainIdentifier)
      throw new Error('App negotiation wallet chain affinity')
    const accountIncarnation = appNegotiationIncarnation(
      input.revision,
      (input.account as PublicAccount).receipt,
    )
    const identity = input.wallet.identity as unknown as {
      compressedPubKey: Uint8Array
    }
    const localPublicKey = new Uint8Array(identity.compressedPubKey)
    const wallet = input.wallet as unknown as WalletHandle
    recovery = new NegotiationRecovery({
      owner: {
        accountIncarnation,
        localPublicKey,
        messagingChainIdentifier: chain.chainIdentifier,
      },
      policy: TESTNET_NEGOTIATION_POLICY,
      openStore: async () =>
        createBrowserNegotiationJournalStore({
          hostDiscriminator: 'app',
          accountIncarnation,
          localPublicKey,
        }),
      scan: sinceMs => scanner.call(messages, { wallet, sinceMs }),
      schedule: (work, delay) => {
        const timer = setTimeout(work, delay)
        return () => clearTimeout(timer)
      },
      publish,
    })
    const owned = recovery
    inspectCurrent = () => owned.snapshot
    recovery.start()
  } catch {
    publish({ state: 'storage-error', coverage: undefined, journals: [] })
  }
  return {
    stop: () => {
      if (current === mine) {
        current = undefined
        inspectCurrent = undefined
        status.value = null
      }
      return recovery?.stop() ?? Promise.resolve()
    },
  }
}
