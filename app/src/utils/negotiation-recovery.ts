import { shallowRef, readonly } from 'vue'
import {
  activeChain,
  type NativeWalletHandle,
  type WalletHandle,
} from '@frank/wallet/chain'
import { createBrowserNegotiationJournalStore } from '@frank/swap-protocol/src/storage/negotiation-browser'
import { appNegotiationIncarnation } from '@frank/swap-protocol/src/host-identity'
import type { NegotiationJournalInspection } from '@frank/swap-protocol/src/negotiation-journal'
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
/** Pause between negotiation mailbox scans while no swap journal is open. */
export const APP_IDLE_NEGOTIATION_SCAN_MS = 60_000
let current: object | undefined
/** Installed after directory admission; independent of chat storage and ordinary polling. */
export interface AppNegotiationRecovery {
  stop(): Promise<void>
  /** This session's journals as last restored (fresh copies; empty once stopped). */
  journals(): readonly NegotiationJournalInspection[]
  /** Called after each published pass of this session's recovery. */
  subscribe(listener: () => void): () => void
}
export function startAppNegotiationRecovery(input: {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
}): AppNegotiationRecovery {
  const mine = {}
  current = mine
  inspectCurrent = undefined
  let reported: string | undefined
  const listeners = new Set<() => void>()
  const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const journals = () =>
    current === mine && inspectCurrent ? inspectCurrent().journals : []
  const publish = (snapshot: NegotiationRecoverySnapshot) => {
    if (current !== mine) return
    status.value = snapshot
    for (const listener of listeners) listener()
    // Say which stored record stopped restoration (for example an old v1 negotiation row and
    // its reset), once per distinct failure.
    if (
      snapshot.state === 'storage-error' &&
      snapshot.failure !== undefined &&
      snapshot.failure !== reported
    ) {
      reported = snapshot.failure
      console.warn(`[swap] Negotiation restore failed: ${snapshot.failure}`)
    }
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
      journals,
      subscribe,
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
      // Every scan is an authenticated mailbox read (a fresh single-use challenge). With no
      // negotiation open, a new offer is picked up within a minute; an open one keeps 3 s.
      activeDelayMs: 3000,
      idleDelayMs: APP_IDLE_NEGOTIATION_SCAN_MS,
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
    journals,
    subscribe,
    stop: () => {
      listeners.clear()
      if (current === mine) {
        current = undefined
        inspectCurrent = undefined
        status.value = null
      }
      return recovery?.stop() ?? Promise.resolve()
    },
  }
}
