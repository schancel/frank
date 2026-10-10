import {
  activeChain,
  createChain,
  getChainRegistryEntry,
  loadMonadChainConfigFromEnv,
  summarizeEvmNativeOperation,
  type EvmNativeOperationStatus,
  type NativeAssetChain,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import { getSolanaRpcUrls } from '@frank/wallet/chain/solana-balance'
import protocol from '../../../docs/protocol/chains/v1.json'
import { accountSession } from './session'

export interface NativeTransferBinding {
  readonly wallet: NativeWalletHandle
  /** Revalidate custody before handing the captured wallet to a signing operation. */
  assertCurrent(): Promise<void>
  /** Reactive session check without opening custody or performing network work. */
  isCurrent(): boolean
}

export interface NativeTransferContext {
  readonly chain: NativeAssetChain
  captureWallet(): Promise<NativeTransferBinding>
}

export type NativeOperationInspection =
  | { status: 'available'; operations: readonly EvmNativeOperationStatus[] }
  | { status: 'unsupported' | 'unavailable' }

/** Inspect an already captured owner. This never opens custody or invokes recovery. */
export function inspectNativeTransferOperations(
  wallet: NativeWalletHandle,
  chainIdentifier: string,
): NativeOperationInspection {
  if (wallet.chainIdentifier !== chainIdentifier)
    return { status: 'unavailable' }
  if (wallet.family !== 'evm' || !wallet.getNativeOperations)
    return { status: 'unsupported' }
  try {
    const rows = wallet.getNativeOperations()
    if (rows.some(row => row.binding.chainIdentifier !== chainIdentifier))
      return { status: 'unavailable' }
    return {
      status: 'available',
      operations: rows.map(row =>
        summarizeEvmNativeOperation(
          row,
          wallet.nativeOperationSyncFailed?.(row.operationId) ?? false,
        ),
      ),
    }
  } catch {
    return { status: 'unavailable' }
  }
}

/** App composition owns network selection; custody and the family wallet own keys/signing. */
export async function createNativeTransferContext(
  chainIdentifier: string,
): Promise<NativeTransferContext> {
  const entry = getChainRegistryEntry(chainIdentifier)
  if (!entry) throw new Error(`Unknown native Send network: ${chainIdentifier}`)

  // activeChain is mutated in place on UI network changes. Never retain that object.
  const primaryChain = { ...activeChain }
  let chain: NativeAssetChain
  let createWallet: (() => Promise<NativeWalletHandle>) | undefined
  if (chainIdentifier === primaryChain.chainIdentifier) {
    chain = primaryChain
  } else if (
    entry.family === 'solana' &&
    entry.wallet &&
    // The Solana adapter's own network type; the registry decides whether a wallet exists.
    (chainIdentifier === 'solana-devnet' ||
      chainIdentifier === 'solana-mainnet')
  ) {
    const genesisHash = protocol.chains
      .find(value => value.id === chainIdentifier)
      ?.identity_probes.find(probe => probe.kind === 'genesis-hash')?.expected
    if (!genesisHash) throw new Error('Solana network identity is unavailable')
    const [{ Connection, Keypair }, { SolanaWallet }] = await Promise.all([
      import('@solana/web3.js'),
      import('@frank/wallet/solana-wallet'),
    ])
    const [rpcUrl] = getSolanaRpcUrls({
      networkId: chainIdentifier,
      relayBaseUrl: loadMonadChainConfigFromEnv().relayBaseUrl,
    })
    const connection = new Connection(rpcUrl, 'confirmed')
    chain = await createChain({
      family: 'solana',
      chainIdentifier,
      config: {
        networkId: chainIdentifier,
        genesisHash,
        connection,
        // This host uses custody domain roots, never the adapter's mnemonic factory.
        deriveSigner: () => {
          throw new Error('Native Send requires the active custody domain root')
        },
      },
    })
    createWallet = async () => {
      const root = await accountSession.getActiveDomainRoot('solana-wallet')
      try {
        // Identical to getChainAddress: no new derivation path or custody format.
        const signer = await Keypair.fromSeed(root)
        return new SolanaWallet({
          connection,
          signer,
          chainIdentifier,
          networkId: chainIdentifier,
          genesisHash,
        })
      } finally {
        root.fill(0)
      }
    }
  } else if (entry.family === 'bitcoin' && entry.wallet) {
    // eCash on Chronik, Bitcoin and Bitcoin Cash on Electrum: one wallet per chain for the
    // session, shared with the balance reader.
    const { openUtxoWallet } = await import('./utxo-wallets')
    const open = await openUtxoWallet(chainIdentifier)
    chain = open.chain as NativeAssetChain
    createWallet = async () => (await openUtxoWallet(chainIdentifier)).wallet
  } else {
    throw new Error(`Native Send is unavailable for ${chainIdentifier}`)
  }

  return {
    chain,
    async captureWallet() {
      const primaryWallet = await accountSession.getWallet()
      const { account, revision } = accountSession.state
      const check = () => {
        const state = accountSession.state
        if (
          state.status !== 'ready' ||
          state.account !== account ||
          state.revision !== revision
        )
          throw new Error('Account changed; review the transfer again')
      }
      const assertCurrent = async () => {
        check()
        const currentWallet = await accountSession.getWallet()
        check()
        if (currentWallet !== primaryWallet) {
          throw new Error('Account changed; review the transfer again')
        }
      }
      const wallet = createWallet ? await createWallet() : primaryWallet
      await assertCurrent()
      if (wallet.chainIdentifier !== chainIdentifier) {
        throw new Error('Wallet network differs from the reviewed network')
      }
      return {
        wallet,
        assertCurrent,
        isCurrent: () => {
          try {
            check()
            return true
          } catch {
            return false
          }
        },
      }
    },
  }
}
