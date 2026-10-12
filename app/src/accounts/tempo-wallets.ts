/** Explicit disabled Tempo PathUSD host. No native-coin wallet or UI capability is advertised. */
import { hexlify } from 'ethers'
import {
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
} from '@frank/wallet/chain'
import { runNativeTransactionExclusive } from '@frank/wallet/chain/chain-wallet'
import { createMonadJsonRpcProvider } from '@frank/wallet/monad-provider'
import { LevelRecordStore } from '@frank/wallet/storage/evm-coin-store'
import {
  TempoPathUsdJournal,
  TempoPathUsdTransfers,
  type TempoPathUsdOperation,
} from '@frank/wallet/chain/tempo-pathusd-operation'
import { TempoPathUsdJsonRpc } from '@frank/wallet/chain/tempo-pathusd-rpc'
import {
  TempoPathUsdReceiveScanner,
  type TempoReceiveBatch,
} from '@frank/wallet/chain/tempo-pathusd-receive'
import { TempoPathUsdWallet } from '@frank/wallet/chain/tempo-pathusd-wallet'
import { accountSession } from './session'

export interface OpenTempoPathUsdWallet {
  readonly wallet: TempoPathUsdWallet
  readonly pendingOperations: readonly TempoPathUsdOperation[]
  close(): Promise<void>
}

/** Caller explicitly selects a canonical Tempo network; the current registry only has Moderato. */
export async function openTempoPathUsdWallet(
  chainIdentifier: 'tempo-testnet',
): Promise<OpenTempoPathUsdWallet> {
  const entry = getChainRegistryEntry(chainIdentifier)
  if (
    entry?.kind !== 'tempo' ||
    entry.id !== chainIdentifier ||
    !entry.nativeChainId ||
    !entry.allowedProxyCapabilities.includes('json-rpc')
  )
    throw new Error('Tempo PathUSD network is unavailable')
  const host = loadMonadChainConfigFromEnv()
  const home = getChainRegistryEntry(host.rpcChain)
  if (
    !home ||
    home.id !== host.rpcChain ||
    home.id !== host.networkId ||
    home.networkTag !== host.networkTag
  )
    throw new Error('Tempo relay identity network is unavailable')
  if (host.walletStorageLocation === false)
    throw new Error('Tempo requires durable wallet storage')
  const sessionWallet = await accountSession.getWallet()
  if (
    sessionWallet.chainIdentifier !== home.id ||
    sessionWallet.networkId !== home.id
  )
    throw new Error('Tempo relay identity does not match the active account')
  const signer = await accountSession.createTempoMainAccountSigner(
    chainIdentifier,
  )
  if (accountSession.peekWallet() !== sessionWallet)
    throw new Error('Account changed while opening Tempo')
  const base = host.relayBaseUrl.trim().replace(/\/+$/, '')
  const identity = sessionWallet.identity as unknown as {
    readonly address: { readonly raw: string }
    signHash(digest: Uint8Array): Uint8Array
  }
  if (
    !identity ||
    typeof identity.signHash !== 'function' ||
    typeof identity.address?.raw !== 'string'
  )
    throw new Error('Tempo relay authentication is unavailable')
  const publicKey = await accountSession.getCurvePublicKey('secp256k1')
  const provider = createMonadJsonRpcProvider({
    rpcUrl: `${base}/chain-rpc/${chainIdentifier}/rpc`,
    chainId: entry.nativeChainId,
    relayAuth: {
      chain: chainIdentifier,
      customer: identity.address.raw,
      subject: hexlify(publicKey).slice(2),
      networkTag: home.networkTag,
      signDigest: digest => {
        if (accountSession.peekWallet() !== sessionWallet)
          throw new Error('Account changed before Tempo relay signing')
        const signature = identity.signHash(Buffer.from(digest))
        if (accountSession.peekWallet() !== sessionWallet)
          throw new Error('Account changed during Tempo relay signing')
        return signature
      },
    },
  })
  const rpc = new TempoPathUsdJsonRpc(
    { send: (method, params) => provider.send(method, [...params]) },
    chainIdentifier,
  )
  // The canonical network and owned address partition durable facts. Source locks span tabs;
  // store-level CAS protects transitions even when a second tab opened before the first wrote.
  const location = `${host.walletStorageLocation}-${chainIdentifier}-${signer.source.address}`
  const lock = <T>(
    role: 'source' | 'recipient',
    address: string,
    work: () => Promise<T>,
  ) =>
    runNativeTransactionExclusive(
      `tempo-pathusd:${chainIdentifier}:${role}:${address}`,
      'single-realm',
      work,
    )
  let operationStore: LevelRecordStore<TempoPathUsdOperation> | undefined
  let receiveStore: LevelRecordStore<TempoReceiveBatch> | undefined
  try {
    await rpc.verifyChain(chainIdentifier)
    if (accountSession.peekWallet() !== sessionWallet)
      throw new Error('Account changed')
    operationStore = await LevelRecordStore.open<TempoPathUsdOperation>(
      location,
      'operations-v1',
    )
    receiveStore = await LevelRecordStore.open<TempoReceiveBatch>(
      location,
      'receive-v1',
    )
    const journal = new TempoPathUsdJournal(operationStore)
    const transfers = new TempoPathUsdTransfers(
      chainIdentifier,
      journal,
      rpc,
      (source, work) => lock('source', source, work),
    )
    const receive = new TempoPathUsdReceiveScanner(
      chainIdentifier,
      receiveStore,
      rpc,
      (recipient, work) => lock('recipient', recipient, work),
    )
    const wallet = new TempoPathUsdWallet(
      chainIdentifier,
      signer,
      rpc,
      transfers,
      receive,
    )
    await lock('source', signer.source.address, () => journal.refresh())
    for (const operation of journal.list()) {
      if (operation.source.address !== signer.source.address)
        throw new Error('Tempo journal contains another source')
      await wallet.reconcile(operation.operationId)
    }
    if (accountSession.peekWallet() !== sessionWallet)
      throw new Error('Account changed')
    let closed = false
    return {
      wallet,
      pendingOperations: journal.list(),
      async close() {
        if (closed) return
        closed = true
        provider.destroy()
        await Promise.all([operationStore!.close(), receiveStore!.close()])
      },
    }
  } catch (error) {
    provider.destroy()
    await Promise.all([operationStore?.close(), receiveStore?.close()])
    throw error
  }
}
