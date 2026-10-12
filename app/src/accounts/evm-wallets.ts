/** One configured EVM owner per canonical network and account session. This cache owns no keys. */
import {
  createEvmChain,
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
  type EvmChainConfig,
  type NativeAssetChain,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import { accountSession } from './session'

export interface EvmOperatorCheckpoint {
  readonly blockNumber: number
  readonly blockHash: string
}
export interface OpenEvmWallet {
  readonly chain: NativeAssetChain
  readonly wallet: NativeWalletHandle & { close(): Promise<void> }
}
interface Opened {
  readonly scope: string
  readonly checkpoint: string
  readonly cancellation: AbortController
  readonly opening: Promise<OpenEvmWallet>
  value?: OpenEvmWallet
  ownsWallet?: boolean
}
const opened = new Map<string, Opened>()
function scopeOf(relayBaseUrl: string): string {
  const { status, account, revision } = accountSession.state
  if (status !== 'ready' || !account) throw new Error('No account is open')
  return JSON.stringify([
    account.receipt.context.accountId,
    revision,
    relayBaseUrl,
  ])
}
/** Explicit network facts come from the canonical registry; these are existing host policies. */
function configured(chainIdentifier: string): EvmChainConfig {
  const entry = getChainRegistryEntry(chainIdentifier)
  if (
    !entry ||
    entry.family !== 'evm' ||
    !entry.wallet ||
    entry.nativeChainId === undefined ||
    !entry.networkTag ||
    !entry.allowedProxyCapabilities.includes('json-rpc')
  )
    throw new Error(`EVM wallet unavailable for ${chainIdentifier}`)
  const host = loadMonadChainConfigFromEnv()
  if (host.walletStorageLocation === false)
    throw new Error('EVM wallet persistence is required')
  return {
    chainIdentifier: entry.id,
    networkId: entry.id,
    rpcChain: entry.id,
    chainId: BigInt(entry.nativeChainId),
    networkTag: entry.networkTag,
    name: entry.name,
    unit: entry.unit,
    relayBaseUrl: host.relayBaseUrl,
    walletStorageLocation: `${host.walletStorageLocation}-${entry.id}`,
    subAccountPoolSize: host.subAccountPoolSize,
    stampBurnAddress: host.stampBurnAddress,
    defaultTopicVoteValueWei: host.defaultTopicVoteValueWei,
    spendSpacingBlocks: entry.spendSpacingBlocks,
    paymentPollIntervalMs: entry.paymentPollIntervalMs,
    reserveBalanceWei:
      entry.reserveBalanceWei === undefined
        ? undefined
        : BigInt(entry.reserveBalanceWei),
  }
}
export function openEvmWallet(
  chainIdentifier: string,
  operatorCheckpoint?: EvmOperatorCheckpoint,
): Promise<OpenEvmWallet> {
  const config = configured(chainIdentifier)
  const scope = scopeOf(config.relayBaseUrl)
  const checkpoint = JSON.stringify(operatorCheckpoint ?? null)
  const existing = opened.get(chainIdentifier)
  if (existing?.scope === scope) {
    if (existing.checkpoint !== checkpoint)
      throw new Error(
        'EVM checkpoint changed; close the existing context first',
      )
    return existing.opening
  }
  existing?.cancellation.abort()
  if (existing?.value && existing.ownsWallet)
    void existing.value.wallet.close().catch(() => undefined)
  const chain = createEvmChain(config)
  const cancellation = new AbortController()
  const entry: Opened = {
    scope,
    checkpoint,
    cancellation,
    opening: Promise.resolve().then(async () => {
      const primary =
        (await accountSession.getWallet()) as NativeWalletHandle & {
          close(): Promise<void>
        }
      const ownsWallet =
        primary.family !== 'evm' || primary.chainIdentifier !== chainIdentifier
      const wallet = ownsWallet
        ? await accountSession.createEvmWallet({
            config,
            operatorCheckpoint,
            signal: cancellation.signal,
          })
        : primary
      entry.ownsWallet = ownsWallet
      if (ownsWallet) {
        const close = wallet.close.bind(wallet)
        wallet.close = async () => {
          if (opened.get(chainIdentifier) === entry)
            opened.delete(chainIdentifier)
          await close()
        }
      }
      if (
        scopeOf(config.relayBaseUrl) !== scope ||
        opened.get(chainIdentifier) !== entry
      ) {
        if (ownsWallet) await wallet.close()
        throw new Error('Account changed')
      }
      const value = { chain, wallet }
      entry.value = value
      return value
    }),
  }
  const opening = entry.opening
  opened.set(chainIdentifier, entry)
  opening.catch(() => {
    if (opened.get(chainIdentifier) === entry) opened.delete(chainIdentifier)
  })
  return opening
}
/** Reference snapshot only: never opens custody, performs RPC, or starts recovery. */
export function peekOpenedEvmWallets(): readonly OpenEvmWallet[] {
  let scope: string
  try {
    scope = scopeOf(loadMonadChainConfigFromEnv().relayBaseUrl)
  } catch {
    return []
  }
  return [...opened.values()].flatMap(entry =>
    entry.scope === scope && entry.value ? [entry.value] : [],
  )
}
/** Host teardown closes owned secondary handles; the session retains ownership of its primary.
 * A cancelled secondary opening closes its late result before publishing it. */
export async function closeOpenedEvmWallets(): Promise<void> {
  const entries = [...opened.values()]
  opened.clear()
  for (const entry of entries) entry.cancellation.abort()
  await Promise.all(
    entries.map(async entry => {
      let value: OpenEvmWallet
      try {
        value = await entry.opening
      } catch {
        return
      }
      if (entry.ownsWallet) await value.wallet.close()
    }),
  )
}
