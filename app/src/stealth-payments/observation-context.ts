import {
  activeChain,
  type NativeAssetChain,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import { accountSession } from '../accounts/session'
import { peekOpenedUtxoWallets } from '../accounts/utxo-wallets'
import type { RecipientAssetObservationContext } from './presentation'
import { stealthAssetKey, type StealthAssetOption } from './options'

type ObservationWallet = Pick<
  NativeWalletHandle,
  'chainIdentifier' | 'stealthReceipts'
>
export interface OpenObservationOwner {
  readonly wallet: ObservationWallet
  readonly chain?: Pick<
    NativeAssetChain,
    'chainIdentifier' | 'name' | 'unit' | 'fromDisplayAmount'
  >
}
/** All getters inspect existing public state. None may initialize a wallet or derive a key. */
export interface RecipientObservationHost {
  snapshot(): {
    readonly ready: boolean
    readonly accountId?: string
    readonly revision: number
  }
  peekWallet(): ObservationWallet | undefined
  getCachedSpendPublicKey(): Uint8Array | undefined
  getOpenedOwners(): readonly OpenObservationOwner[]
}

/** Additional family caches can be composed here without importing their activation paths. */
export function cachedRecipientObservationHost(
  additionalOwners: () => readonly OpenObservationOwner[] = () => [],
): RecipientObservationHost {
  return {
    snapshot: () => ({
      ready: accountSession.state.status === 'ready',
      accountId: accountSession.state.account?.receipt.context.accountId,
      revision: accountSession.state.revision,
    }),
    peekWallet: () => accountSession.peekWallet(),
    getCachedSpendPublicKey: () =>
      accountSession.getCachedCurvePublicKey('secp256k1'),
    getOpenedOwners: () => {
      const wallet = accountSession.peekWallet()
      return [
        ...(wallet ? [{ wallet, chain: activeChain }] : []),
        ...peekOpenedUtxoWallets(),
        ...additionalOwners(),
      ]
    },
  }
}

const cachedHost = cachedRecipientObservationHost()
function sameBytes(a: Uint8Array | undefined, b: Uint8Array): boolean {
  return (
    !!a &&
    a.length === b.length &&
    a.every((value, index) => value === b[index])
  )
}

/** Observation is bound to the ready account and the exact cached owner, across network waits. */
export function createRecipientAssetObservationContext(
  payloadDigest: string,
  host: RecipientObservationHost = cachedHost,
): RecipientAssetObservationContext | undefined {
  const initial = { ...host.snapshot() }
  if (
    !initial.ready ||
    !initial.accountId ||
    !/^[a-f0-9]{64}$/i.test(payloadDigest)
  )
    return undefined
  const cachedKey = host.getCachedSpendPublicKey()
  if (!cachedKey || cachedKey.length !== 33) return undefined
  const spendPublicKey = cachedKey.slice()
  const primary = host.peekWallet()
  const consultedOwners = new Map<string, ObservationWallet>()
  const assertCurrent = () => {
    const current = host.snapshot()
    if (
      !current.ready ||
      current.accountId !== initial.accountId ||
      current.revision !== initial.revision ||
      host.peekWallet() !== primary ||
      !sameBytes(host.getCachedSpendPublicKey(), spendPublicKey)
    ) {
      throw new Error('Receipt observation context expired')
    }
    const openedOwners = host.getOpenedOwners()
    for (const [chainIdentifier, owner] of consultedOwners) {
      if (
        openedOwners.find(
          entry => entry.wallet.chainIdentifier === chainIdentifier,
        )?.wallet !== owner
      ) {
        throw new Error('Receipt observation owner expired')
      }
    }
  }
  return {
    payloadDigest,
    // Keep the lifecycle comparison separate from the public caller's mutable bytes.
    spendPublicKey: spendPublicKey.slice(),
    assertCurrent,
    receipts(chainIdentifier) {
      assertCurrent()
      const owner = host
        .getOpenedOwners()
        .find(entry => entry.wallet.chainIdentifier === chainIdentifier)?.wallet
      const capability = owner?.stealthReceipts
      if (!owner || !capability) return undefined
      consultedOwners.set(chainIdentifier, owner)
      const assertOwner = () => {
        assertCurrent()
        if (
          !host.getOpenedOwners().some(entry => entry.wallet === owner) ||
          owner.stealthReceipts !== capability
        ) {
          throw new Error('Receipt observation owner expired')
        }
      }
      return {
        async observe(claim) {
          assertOwner()
          if (
            claim.chainIdentifier !== chainIdentifier ||
            claim.payloadDigest !== payloadDigest
          ) {
            throw new Error('Receipt observation affinity mismatch')
          }
          const result = await capability.observe(claim)
          assertOwner()
          return result
        },
      }
    },
  }
}

/** Precision comes from already constructed chain adapters, without opening custody or balances. */
export function cachedRecipientAssetOptions(
  host: RecipientObservationHost = cachedHost,
): readonly StealthAssetOption[] {
  if (!host.snapshot().ready) return []
  const seen = new Set<string>()
  return host.getOpenedOwners().flatMap(({ wallet, chain }) => {
    if (
      !chain ||
      chain.chainIdentifier !== wallet.chainIdentifier ||
      seen.has(chain.chainIdentifier)
    )
      return []
    const scale = chain.fromDisplayAmount('1').toString()
    if (!/^10*$/.test(scale)) return []
    seen.add(chain.chainIdentifier)
    const decimals = scale.length - 1
    return [
      {
        key: stealthAssetKey(chain.chainIdentifier, { kind: 'native' }),
        chainIdentifier: chain.chainIdentifier,
        asset: { kind: 'native' as const },
        label: `${chain.name} · ${chain.unit}`,
        unit: chain.unit,
        decimals,
        nativeUnit: chain.unit,
        nativeDecimals: decimals,
      },
    ]
  })
}

/** These are message delivery facts; no chain-settlement claim is inferred. */
export function recipientAssetOutboundState(status: string): string {
  if (status === 'confirmed') return 'delivered'
  if (status === 'error') return 'failed'
  if (status === 'pending' || status === 'sending') return status
  return 'unknown'
}
