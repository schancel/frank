/** One configured EVM owner per canonical network and account session. This cache owns no keys. */
import {
  activeChain,
  createNativeOnlyEvmChain,
  DirectMessageAlreadyAttemptedError,
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
  PROTOCOL_CHAINS,
  type EvmChainConfig,
  type EvmChainWalletHandle,
  type NativeAssetChain,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import type {
  SwapRecordItem,
  WalletSyncItem,
} from '@frank/cashweb/types/messages'
import { accountSession } from './session'
import {
  validateEvmWalletConfiguration,
  verifyEvmWalletRpcIdentity,
} from './evm-wallet-verification'

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
  sessionWallet?: NativeWalletHandle
}
const opened = new Map<string, Opened>()
// Lifecycle barriers outlive cache eviction; failed retirement remains fail-closed.
const retirements = new Map<string, Set<Promise<void>>>()
function retainRetirement(
  chainIdentifier: string,
  closing: Promise<void>,
): Promise<void> {
  let pending = retirements.get(chainIdentifier)
  if (!pending) retirements.set(chainIdentifier, (pending = new Set()))
  pending.add(closing)
  void closing.then(
    () => {
      pending.delete(closing)
      if (pending.size === 0 && retirements.get(chainIdentifier) === pending)
        retirements.delete(chainIdentifier)
    },
    () => undefined,
  )
  return closing
}
function normalizedRelay(url: string): string {
  return url.trim().replace(/\/+$/, '')
}
function sameSessionOwner(entry: Opened): boolean {
  const primary = accountSession.peekWallet()
  return (
    primary !== undefined &&
    (!entry.sessionWallet || entry.sessionWallet === primary)
  )
}
function scopeOf(relayBaseUrl: string): string {
  const { status, account, revision } = accountSession.state
  if (status !== 'ready' || !account) throw new Error('No account is open')
  return JSON.stringify([
    account.receipt.context.accountId,
    revision,
    normalizedRelay(relayBaseUrl),
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
    relayBaseUrl: normalizedRelay(host.relayBaseUrl),
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
  const checkpointInput = operatorCheckpoint && { ...operatorCheckpoint }
  // A secondary chain emits a transport-free sync event. Capture the primary messaging service
  // now, so a later UI network change cannot redirect a pending operation's self note.
  const messenger = { ...activeChain }
  const baseConfig = configured(chainIdentifier)
  const emitWalletSync = async (
    item: WalletSyncItem,
    swapRecord: SwapRecordItem | undefined,
    messageId: Uint8Array,
  ): Promise<void> => {
    const requireBoundOwner = () => {
      if (
        item.chainIdentifier !== chainIdentifier ||
        !sameSessionOwner(entry) ||
        entry.cancellation.signal.aborted ||
        opened.get(chainIdentifier) !== entry ||
        scopeOf(baseConfig.relayBaseUrl) !== scope
      )
        throw new Error('EVM wallet sync owner changed')
    }
    requireBoundOwner()
    const primary = entry.sessionWallet
    if (
      !primary ||
      messenger.chainIdentifier !== primary.chainIdentifier ||
      !messenger.capabilities.directMessages ||
      (primary.family === 'evm' &&
        normalizedRelay((primary as EvmChainWalletHandle).relayBaseUrl) !==
          normalizedRelay(baseConfig.relayBaseUrl))
    )
      throw new Error('Primary wallet messaging is unavailable')
    try {
      await messenger.directMessages.send({
        wallet: primary,
        recipient: primary.identity.address,
        items: swapRecord ? [item, swapRecord] : [item],
        stampValue: 0n,
        messageId,
      })
    } catch (error) {
      if (!(error instanceof DirectMessageAlreadyAttemptedError)) throw error
      const status = (
        await messenger.directMessages.reconcileAttempts({
          wallet: primary,
          payloadDigests: [error.payloadDigest],
        })
      )[error.payloadDigest]
      if (status !== 'delivered') throw error
    }
    requireBoundOwner()
  }
  const config: EvmChainConfig = {
    ...baseConfig,
    ...(getChainRegistryEntry(chainIdentifier)?.kind === 'monad'
      ? {}
      : { emitWalletSync }),
  }
  validateEvmWalletConfiguration(config, checkpointInput)
  const scope = scopeOf(config.relayBaseUrl)
  const checkpoint = JSON.stringify(checkpointInput ?? null)
  const existing = opened.get(chainIdentifier)
  if (existing?.scope === scope && sameSessionOwner(existing)) {
    if (existing.checkpoint !== checkpoint)
      throw new Error(
        'EVM checkpoint changed; close the existing context first',
      )
    return existing.opening.then(value => {
      if (!sameSessionOwner(existing)) throw new Error('Account changed')
      return value
    })
  }
  existing?.cancellation.abort()
  const retiring =
    existing?.value && existing.ownsWallet
      ? existing.value.wallet.close()
      : existing?.opening.then(
          async value => {
            if (existing.ownsWallet) await value.wallet.close()
          },
          () => undefined,
        )
  const retirementBarrier = Promise.all([
    ...(retirements.get(chainIdentifier) ?? []),
    ...(retiring ? [retiring] : []),
  ])
  const chain = createNativeOnlyEvmChain(config)
  const cancellation = new AbortController()
  const entry: Opened = {
    scope,
    checkpoint,
    cancellation,
    opening: Promise.resolve().then(async () => {
      await retirementBarrier
      if (
        cancellation.signal.aborted ||
        scopeOf(config.relayBaseUrl) !== scope ||
        opened.get(chainIdentifier) !== entry
      )
        throw new Error('Account changed')
      const primary =
        (await accountSession.getWallet()) as NativeWalletHandle & {
          close(): Promise<void>
        }
      entry.sessionWallet = primary
      if (!sameSessionOwner(entry)) throw new Error('Account changed')
      const ownsWallet =
        primary.family !== 'evm' || primary.chainIdentifier !== chainIdentifier
      const wallet = ownsWallet
        ? await accountSession.createEvmWallet({
            config,
            operatorCheckpoint: checkpointInput,
            signal: cancellation.signal,
          })
        : primary
      entry.ownsWallet = ownsWallet
      if (!ownsWallet) {
        const capturedRelay = (primary as EvmChainWalletHandle).relayBaseUrl
        if (
          typeof capturedRelay !== 'string' ||
          normalizedRelay(capturedRelay) !==
            normalizedRelay(config.relayBaseUrl)
        )
          throw new Error('Primary EVM relay differs from the configured relay')
        const requireCurrent = () => {
          if (
            !sameSessionOwner(entry) ||
            cancellation.signal.aborted ||
            scopeOf(config.relayBaseUrl) !== scope ||
            opened.get(chainIdentifier) !== entry
          )
            throw new Error('Account changed')
        }
        requireCurrent()
        await verifyEvmWalletRpcIdentity(
          config,
          (primary as EvmChainWalletHandle).provider,
          checkpointInput,
          requireCurrent,
        )
      }
      if (ownsWallet) {
        const close = wallet.close.bind(wallet)
        let closing: Promise<void> | undefined
        wallet.close = () => {
          if (closing) return closing
          if (opened.get(chainIdentifier) === entry)
            opened.delete(chainIdentifier)
          try {
            closing = close()
          } catch (error) {
            closing = Promise.reject(error)
          }
          return retainRetirement(chainIdentifier, closing)
        }
      }
      if (
        !sameSessionOwner(entry) ||
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
    entry.scope === scope && sameSessionOwner(entry) && entry.value
      ? [entry.value]
      : [],
  )
}
/** Active-session recovery of secondary EVM journals. Network looks and self-note retries use
 * the original signed members; this path never constructs or authorizes another payment. */
export async function recoverSecondaryEvmWallets(
  primary: NativeWalletHandle,
): Promise<void> {
  const peers = Object.values(PROTOCOL_CHAINS).filter(
    entry => entry.family === 'evm' && entry.kind !== 'monad' && entry.wallet,
  )
  if (peers.length === 0) return
  if (accountSession.peekWallet() !== primary)
    throw new Error('EVM recovery owner changed')
  const results = await Promise.allSettled(
    peers.map(async peer => {
      const opened = await openEvmWallet(peer.id)
      if (
        accountSession.peekWallet() !== primary ||
        opened.wallet.chainIdentifier !== peer.id
      )
        throw new Error(`EVM recovery owner changed for ${peer.id}`)
      await opened.wallet.reobserveNativeOperations?.()
      const remaining = await opened.wallet.flushNativeSync?.()
      if (remaining?.length)
        throw new Error(
          `Wallet sync remains pending for ${peer.id}: ${remaining.join(', ')}`,
        )
    }),
  )
  const errors = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [`${peers[index]!.id}: ${String(result.reason)}`]
      : [],
  )
  if (errors.length)
    throw new Error(`Secondary EVM recovery incomplete: ${errors.join('; ')}`)
}
/** Host teardown closes owned secondary handles; the session retains ownership of its primary.
 * A cancelled secondary opening closes its late result before publishing it. */
export async function closeOpenedEvmWallets(): Promise<void> {
  const entries = [...opened.entries()]
  for (const [, entry] of entries) entry.cancellation.abort()
  const closing = entries.map(([chainIdentifier, entry]) => {
    if (entry.value && entry.ownsWallet) return entry.value.wallet.close()
    return retainRetirement(
      chainIdentifier,
      entry.opening.then(
        async value => {
          if (entry.ownsWallet) await value.wallet.close()
        },
        () => undefined,
      ),
    )
  })
  opened.clear()
  await Promise.all(closing)
}
