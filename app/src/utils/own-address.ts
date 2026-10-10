import { activeChain } from '@frank/wallet/chain'
import {
  effectScope,
  getCurrentScope,
  onScopeDispose,
  readonly,
  ref,
  watch,
  type DeepReadonly,
  type Ref,
} from 'vue'

export type OwnAddressResult =
  | { address: string; error?: undefined }
  // `error` is set for an unexpected failure (e.g. a wallet handle of the wrong shape) and is
  // undefined when the wallet is simply not set up yet.
  | { address: null; error?: unknown }

/**
 * The current identity's canonical address (the same `formatAddress` form used as the
 * contact/chat store key), or `address: null` when it cannot be determined. Callers use it to
 * refuse adding the user as their own contact, so it fails open rather than blocking every add;
 * unexpected failures are additionally reported through `error` and `console.error`.
 */
export async function resolveOwnAddress(): Promise<OwnAddressResult> {
  try {
    // Loaded lazily: the wallet store opens its persistent UTXO database on import, which the
    // contact store (imported everywhere) must not do as a side effect.
    const { useActiveWallet } = await import('src/composables/useActiveWallet')
    let wallet
    try {
      wallet = await useActiveWallet()
    } catch {
      return { address: null } // wallet not initialized (no seed phrase yet)
    }
    return { address: activeChain.formatAddress(wallet.identity.address) }
  } catch (error) {
    console.error('Could not determine the own address:', error)
    return { address: null, error }
  }
}

export async function getOwnCanonicalAddress(): Promise<string | null> {
  return (await resolveOwnAddress()).address
}

/** Reactive presentation identity for long-lived layout/list components. A seed change clears the
 * old address synchronously, then publishes only the newest async resolution. The seed remains in
 * the wallet store and is never exposed as a component key or returned from this helper. */
export function useReactiveOwnCanonicalAddress(): DeepReadonly<
  Ref<string | null>
> {
  const address = ref<string | null>(null)
  let request = 0
  const scope = effectScope()
  let disposed = false
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      scope.stop()
    })
  }
  void import('../accounts/session').then(({ accountStatus }) => {
    if (disposed) return
    scope.run(() =>
      watch(
        () => [accountStatus.revision, accountStatus.status],
        async () => {
          const currentRequest = ++request
          address.value = null
          const resolved = await getOwnCanonicalAddress()
          if (currentRequest === request) address.value = resolved
        },
        { immediate: true, flush: 'sync' },
      ),
    )
  })
  return readonly(address)
}

/** Compares any two accepted spellings at the presentation/storage edge. */
export function sameCanonicalAddress(
  first: string | null | undefined,
  second: string | null | undefined,
): boolean {
  if (!first || !second) return false
  try {
    const firstParsed = activeChain.parseAddress(first)
    const secondParsed = activeChain.parseAddress(second)
    return (
      firstParsed !== null &&
      secondParsed !== null &&
      activeChain.formatAddress(firstParsed) ===
        activeChain.formatAddress(secondParsed)
    )
  } catch {
    return false
  }
}

/** True when `address` (any form the chain parses) is the current identity's own address. */
export async function isOwnAddress(address: string): Promise<boolean> {
  const own = await getOwnCanonicalAddress()
  return sameCanonicalAddress(address.trim(), own)
}

/**
 * Resolves all addresses known to belong to the active wallet session:
 * - Identity address (canonical formatted and raw)
 * - Receive address
 * - Sub-account pool records (used for topic post burns and dm stamps)
 * - Change pool records
 * - Registered stealth addresses
 */
export async function resolveOwnAddresses(): Promise<string[]> {
  try {
    const { useActiveWallet } = await import('src/composables/useActiveWallet')
    let wallet: any
    try {
      wallet = await useActiveWallet()
    } catch {
      return []
    }
    const set = new Set<string>()

    const addAddress = (addr: unknown) => {
      if (!addr) return
      if (typeof addr === 'string') {
        const trimmed = addr.trim()
        if (trimmed) {
          set.add(trimmed)
          try {
            const parsed = activeChain.parseAddress(trimmed)
            if (parsed) {
              set.add(activeChain.formatAddress(parsed))
            }
          } catch {
            // ignore
          }
        }
      } else if (typeof addr === 'object' && addr !== null) {
        if ('raw' in addr && typeof (addr as any).raw === 'string') {
          addAddress((addr as any).raw)
        }
        try {
          const formatted = activeChain.formatAddress(addr as any)
          if (formatted) set.add(formatted)
        } catch {
          // ignore
        }
      }
    }

    if (wallet?.identity?.address) {
      addAddress(wallet.identity.address)
    }

    if (typeof wallet?.getReceiveAddress === 'function') {
      try {
        const recv = await wallet.getReceiveAddress()
        addAddress(recv)
      } catch {
        // ignore
      }
    }

    if (wallet?.pool && typeof wallet.pool.records === 'function') {
      try {
        const records = wallet.pool.records()
        if (Array.isArray(records)) {
          for (const rec of records) {
            if (rec?.address) addAddress(rec.address)
          }
        }
      } catch {
        // ignore
      }
    }

    if (wallet?.changePool && typeof wallet.changePool.records === 'function') {
      try {
        const records = wallet.changePool.records()
        if (Array.isArray(records)) {
          for (const rec of records) {
            if (rec?.address) addAddress(rec.address)
          }
        }
      } catch {
        // ignore
      }
    }

    // One-time accounts money arrived at (stealth payments, stamps): the wallet's coin list.
    if (typeof wallet?.getReceivedPayments === 'function') {
      try {
        for (const payment of wallet.getReceivedPayments()) {
          if (payment?.address) addAddress(payment.address)
        }
      } catch {
        // ignore
      }
    }

    return Array.from(set)
  } catch (error) {
    console.error('Could not determine own addresses:', error)
    return []
  }
}

const ownAddressesRevision = ref(0)

/** Notifies components that the wallet's pool or derived addresses have expanded. */
export function notifyOwnAddressesChanged(): void {
  ownAddressesRevision.value += 1
}

/** Reactive list of all addresses belonging to the active wallet, including sub-account pool. */
export function useReactiveOwnAddresses(): DeepReadonly<Ref<string[]>> {
  const addresses = ref<string[]>([])
  let request = 0
  const scope = effectScope()
  let disposed = false
  if (getCurrentScope()) {
    onScopeDispose(() => {
      disposed = true
      scope.stop()
    })
  }
  void import('../accounts/session').then(({ accountStatus }) => {
    if (disposed) return
    scope.run(() =>
      watch(
        () => [
          accountStatus.revision,
          accountStatus.status,
          ownAddressesRevision.value,
        ],
        async () => {
          const currentRequest = ++request
          addresses.value = []
          const resolved = await resolveOwnAddresses()
          if (currentRequest === request) addresses.value = resolved
        },
        { immediate: true, flush: 'sync' },
      ),
    )
  })
  return readonly(addresses)
}

/** Tests whether a candidate address belongs to the provided list or ref of own addresses. */
export function isKnownOwnAddress(
  candidate: string | null | undefined,
  ownAddresses:
    | string[]
    | readonly string[]
    | Ref<string[]>
    | DeepReadonly<Ref<string[]>>
    | null
    | undefined,
): boolean {
  if (!candidate || typeof candidate !== 'string') return false
  const trimmed = candidate.trim()
  if (!trimmed) return false

  const list =
    typeof ownAddresses === 'object' &&
    ownAddresses !== null &&
    'value' in ownAddresses
      ? (ownAddresses as any).value
      : ownAddresses

  if (!Array.isArray(list)) return false
  const candidateLower = trimmed.toLowerCase()

  for (const addr of list) {
    if (!addr || typeof addr !== 'string') continue
    const addrTrimmed = addr.trim()
    if (
      candidateLower === addrTrimmed.toLowerCase() ||
      sameCanonicalAddress(trimmed, addrTrimmed)
    ) {
      return true
    }
  }
  return false
}
