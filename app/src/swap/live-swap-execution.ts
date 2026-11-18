/**
 * Live browser swap execution runtime for testnet (`xec-testnet` ↔ `monad-testnet`).
 *
 * Wires `SwapExecutionCoordinator` to `BrowserSwapExecutionStore` (with no `indexedDB` nothing
 * runs and the card shows that the records could not be opened), the session's `xec-testnet`
 * `EcashWallet` + Chronik client, and the session's `monad-testnet` `EvmChainWalletHandle` +
 * `MonadAccountTxSigner`.
 */
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha256.js'
import { ethers } from 'ethers'
import { ChronikClient } from 'chronik-client'
import { toHex } from '@frank/codec'
import {
  activeChain,
  loadMonadChainConfigFromEnv,
  type EvmChainWalletHandle,
  type NativeWalletHandle,
} from '@frank/wallet/chain'
import type { EcashWallet } from '@frank/wallet/ecash-wallet'
import type { EcashSdkWallet } from '@frank/wallet/ecash-sdk-backend'
import { MonadAccountTxSigner } from '@frank/wallet/evm-account-tx'
import {
  SWAP_FINALITY_CONFIRMATIONS,
  type EvmSwapCapability,
  type LegFundingObservation,
  type LegSettlementObservation,
  type SwapCustodyHoldCapability,
  type SwapRole,
  type XecSwapCapability,
} from '@frank/swap-protocol/src/swap-execution-runtime'
import { BrowserSwapExecutionStore } from '@frank/swap-protocol/src/storage/execution-browser'
import { appNegotiationIncarnation } from '@frank/swap-protocol/src/host-identity'
import { TESTNET_NEGOTIATION_POLICY } from '@frank/swap-protocol/src/negotiation'
import type { PublicAccount } from '../accounts/custody'
import { openUtxoWallet } from '../accounts/utxo-wallets'
import {
  createSwapExecutionCoordinator,
  failSwapExecutionRestore,
  installSwapExecutionCoordinator,
  refreshSwapExecutionRecords,
  type SwapExecutionOwner,
} from './swap-execution-commands'

const XEC_SWEEP_FEE_BUFFER_SATS = 300n
const XEC_CLAIMED_STORAGE_PREFIX = 'frank-swap-xec-claimed:'
const XEC_REFUNDED_STORAGE_PREFIX = 'frank-swap-xec-refunded:'
const EVM_CLAIMED_STORAGE_PREFIX = 'frank-swap-evm-claimed:'
const EVM_REFUNDED_STORAGE_PREFIX = 'frank-swap-evm-refunded:'

function readLocalTag(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined'
      ? localStorage.getItem(key)
      : null
  } catch {
    return null
  }
}

function writeLocalTag(key: string, value: string): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(key, value)
    }
  } catch {
    // ignore storage errors
  }
}

function getChronikClient(): ChronikClient {
  const relay = loadMonadChainConfigFromEnv().relayBaseUrl.replace(/\/+$/, '')
  return new ChronikClient([
    `${relay}/chain-rpc/${TESTNET_NEGOTIATION_POLICY.xecChainIdentifier}/chronik`,
  ])
}

function deriveXecEscrowSeed(
  swapId: string,
  initiatorPub: string,
  responderPub: string,
): Uint8Array {
  return sha256(
    utf8ToBytes(
      [
        'frank/swap-testnet-xec-escrow/v1',
        swapId.toLowerCase(),
        initiatorPub.toLowerCase(),
        responderPub.toLowerCase(),
      ].join('|'),
    ),
  )
}

function deriveEvmEscrowPrivateKeyHex(
  swapId: string,
  initiatorPub: string,
  responderPub: string,
): string {
  const digest = sha256(
    utf8ToBytes(
      [
        'frank/swap-testnet-evm-escrow/v1',
        swapId.toLowerCase(),
        initiatorPub.toLowerCase(),
        responderPub.toLowerCase(),
      ].join('|'),
    ),
  )
  return `0x${bytesToHex(digest)}`
}

async function openXecEscrowSdk(
  swapId: string,
  initiatorPub: string,
  responderPub: string,
  chronik: ChronikClient,
): Promise<{
  sdk: EcashSdkWallet
  address: string
  pkhHex: string
}> {
  const seed = deriveXecEscrowSeed(swapId, initiatorPub, responderPub)
  const imported = await import('ecash-wallet/dist/index.js')
  const { HdNode, shaRmd160 } = await import('ecash-lib')
  const sdkModule = imported as unknown as {
    Wallet?: new (
      sk: Uint8Array,
      chronik: ChronikClient,
      baseHdNode: unknown,
      accountNumber: number,
      prefix: 'ectest',
    ) => EcashSdkWallet
    default?: {
      Wallet?: new (
        sk: Uint8Array,
        chronik: ChronikClient,
        baseHdNode: unknown,
        accountNumber: number,
        prefix: 'ectest',
      ) => EcashSdkWallet
    }
  }
  const WalletCtor = sdkModule.Wallet ?? sdkModule.default?.Wallet
  if (typeof WalletCtor !== 'function') {
    throw new Error('ecash-wallet did not export Wallet')
  }
  const account = HdNode.fromSeed(seed).derivePath("m/44'/1899'/0'")
  const child0 = account.derivePath('0/0')
  const pkhHex = bytesToHex(shaRmd160(child0.pubkey()))
  const seckey = account.seckey()
  if (!seckey) throw new Error('eCash swap escrow key has no private key')
  const sdk = new WalletCtor(seckey, chronik, account, 0, 'ectest')
  const address = sdk.getReceiveAddress(0)
  return { sdk, address, pkhHex }
}

async function sweepXecEscrowTo(
  swapId: string,
  initiatorPub: string,
  responderPub: string,
  recipientAddress: string,
  chronik: ChronikClient,
): Promise<string> {
  const { sdk } = await openXecEscrowSdk(
    swapId,
    initiatorPub,
    responderPub,
    chronik,
  )
  await sdk.sync()
  const coins = sdk.spendableSatsOnlyUtxos()
  const totalSats = coins.reduce((sum, c) => sum + BigInt(c.sats), 0n)
  if (totalSats <= 546n) {
    throw new Error('Insufficient funds in eCash swap escrow')
  }
  let sendSats = totalSats - XEC_SWEEP_FEE_BUFFER_SATS
  if (sendSats < 546n) sendSats = 546n
  const built = sdk
    .action({
      outputs: [{ address: recipientAddress, sats: sendSats }],
    })
    .build(undefined, { skipAutoConsolidateOnMaxTxSize: true })
  const tx = built.builtTxs[0]
  const rawHex = bytesToHex(tx.tx.ser())
  await chronik.broadcastTx(rawHex).catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    if (!/already|mempool|txn-already-known/i.test(msg)) {
      throw err
    }
  })
  return tx.txid
}

function parseActionDescriptor(raw: string): {
  kind: string
  swapId: string
  initiatorPub: string
  responderPub: string
  extra: string
} | null {
  const parts = raw.split(':')
  if (parts.length < 5 || !parts[0].startsWith('swap-')) return null
  return {
    kind: parts[0],
    swapId: parts[1],
    initiatorPub: parts[2],
    responderPub: parts[3],
    extra: parts.slice(4).join(':'),
  }
}

/** A funding seen `confirmations` blocks deep (the block it is in counts as one). */
function depthObservation(
  confirmations: number,
): Pick<LegFundingObservation, 'status' | 'confirmations'> {
  return {
    status:
      confirmations >= SWAP_FINALITY_CONFIRMATIONS
        ? 'final'
        : confirmations > 0
        ? 'included'
        : 'unseen',
    confirmations: Math.max(0, confirmations),
  }
}

/**
 * The funding of a swap's eCash escrow address, from its Chronik history: the payment that
 * brought what it received to the principal, how deep that payment is, and whether the
 * escrow has been swept since (it holds less than the principal now).
 */
export function xecEscrowFundingObservation(input: {
  principalSats: bigint
  /** The escrow's P2PKH output script, hex. */
  escrowOutputScript: string
  tipHeight: number
  history: readonly {
    txid: string
    block?: { height: number; hash: string }
    outputs: readonly { outputScript: string; sats: bigint }[]
  }[]
  /** What the escrow address holds now, mempool included. */
  unspentSats: bigint
}): LegFundingObservation {
  const payments = input.history
    .map(tx => ({
      txid: tx.txid,
      block: tx.block,
      sats: tx.outputs
        .filter(o => o.outputScript === input.escrowOutputScript)
        .reduce((sum, o) => sum + o.sats, 0n),
    }))
    .filter(p => p.sats > 0n)
    // Oldest first; mempool payments last.
    .sort(
      (a, b) =>
        (a.block?.height ?? Number.MAX_SAFE_INTEGER) -
        (b.block?.height ?? Number.MAX_SAFE_INTEGER),
    )
  let received = 0n
  const funding = payments.find(
    p => (received += p.sats) >= input.principalSats,
  )
  if (!funding || input.principalSats <= 0n) {
    return { status: 'unseen', confirmations: 0 }
  }
  const spent = input.unspentSats < input.principalSats
  if (!funding.block) {
    return { status: 'unseen', txId: funding.txid, confirmations: 0, spent }
  }
  return {
    ...depthObservation(input.tipHeight - funding.block.height + 1),
    txId: funding.txid,
    blockHeight: funding.block.height,
    blockHash: funding.block.hash,
    spent,
  }
}

/**
 * The funding of a swap's EVM escrow account. Funded means the account held the principal,
 * or has sent a transaction (it was swept, which only a funded escrow can be).
 *
 * The depth counts from the earliest block the escrow is known funded at (`blockHeight`):
 * found from the account's state over the latest blocks where the node serves it, and in any
 * case no later than the block of an earlier observation (`previous`, as stored in the swap
 * record). A node without historical state therefore still lets a funded leg grow deep and
 * become final across observations.
 */
export async function observeEvmEscrowFunding(
  provider: Pick<
    ethers.Provider,
    'getBlockNumber' | 'getBalance' | 'getTransactionCount'
  >,
  escrowAddress: string,
  principalWei: bigint,
  previous?: LegFundingObservation,
): Promise<LegFundingObservation> {
  const stateAt = async (block: number) => {
    const [balance, nonce] = await Promise.all([
      provider.getBalance(escrowAddress, block),
      provider.getTransactionCount(escrowAddress, block),
    ])
    return { balance, nonce, funded: balance >= principalWei || nonce > 0 }
  }
  const tip = await provider.getBlockNumber()
  const latest = await stateAt(tip)
  if (principalWei <= 0n || !latest.funded) {
    return { status: 'unseen', confirmations: 0 }
  }
  const spent = latest.balance < principalWei

  let fundedAt = tip
  if (
    previous &&
    previous.status !== 'unseen' &&
    previous.blockHeight !== undefined &&
    previous.blockHeight <= tip
  ) {
    fundedAt = previous.blockHeight
  }
  try {
    const deepest = Math.max(0, tip - (SWAP_FINALITY_CONFIRMATIONS - 1))
    if (fundedAt > deepest) {
      if ((await stateAt(deepest)).funded) {
        fundedAt = deepest
      } else {
        // The earliest block of the window in which the escrow is funded.
        let low = deepest + 1
        let high = fundedAt
        while (low < high) {
          const mid = Math.floor((low + high) / 2)
          if ((await stateAt(mid)).funded) high = mid
          else low = mid + 1
        }
        fundedAt = low
      }
    }
  } catch {
    // The node serves no state for those blocks: the earliest block seen funded stands.
  }
  return {
    ...depthObservation(tip - fundedAt + 1),
    txId: escrowAddress,
    blockHeight: fundedAt,
    spent,
  }
}

export function createLiveXecSwapCapability(): XecSwapCapability {
  return {
    // A new swap cannot be funded (see `SwapExecutionDisabledError`).
    reserveInputs: refuseNewSwapExecution,

    async broadcastTransaction(txHex: string) {
      const desc = parseActionDescriptor(txHex)
      if (desc) {
        if (desc.kind === 'swap-xec-watch') {
          return { txid: txHex }
        }
        if (desc.kind === 'swap-xec-claim') {
          const role = desc.extra as SwapRole
          if (role !== 'responder') {
            return { txid: txHex }
          }
          const existing = readLocalTag(
            `${XEC_CLAIMED_STORAGE_PREFIX}${desc.swapId}`,
          )
          if (existing) return { txid: existing }
          const { wallet } = await openUtxoWallet(
            TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
          )
          const receiveAddr = (await wallet.getReceiveAddress()).raw
          const chronik = getChronikClient()
          const txid = await sweepXecEscrowTo(
            desc.swapId,
            desc.initiatorPub,
            desc.responderPub,
            receiveAddr,
            chronik,
          )
          writeLocalTag(`${XEC_CLAIMED_STORAGE_PREFIX}${desc.swapId}`, txid)
          await wallet.getBalance().catch(() => undefined)
          return { txid }
        }
        if (desc.kind === 'swap-xec-refund') {
          const role = desc.extra as SwapRole
          if (role !== 'initiator') {
            return { txid: txHex }
          }
          const existing = readLocalTag(
            `${XEC_REFUNDED_STORAGE_PREFIX}${desc.swapId}`,
          )
          if (existing) return { txid: existing }
          const { wallet } = await openUtxoWallet(
            TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
          )
          const receiveAddr = (await wallet.getReceiveAddress()).raw
          const chronik = getChronikClient()
          const txid = await sweepXecEscrowTo(
            desc.swapId,
            desc.initiatorPub,
            desc.responderPub,
            receiveAddr,
            chronik,
          )
          writeLocalTag(`${XEC_REFUNDED_STORAGE_PREFIX}${desc.swapId}`, txid)
          await wallet.getBalance().catch(() => undefined)
          return { txid }
        }
      }

      const chronik = getChronikClient()
      const res = await chronik.broadcastTx(txHex).catch(err => {
        const msg = err instanceof Error ? err.message : String(err)
        if (/already|mempool|txn-already-known/i.test(msg)) {
          return { txid: '' }
        }
        throw err
      })
      await openUtxoWallet(TESTNET_NEGOTIATION_POLICY.xecChainIdentifier)
        .then(w => w.wallet.getBalance())
        .catch(() => undefined)
      return { txid: res.txid || txHex.slice(0, 64) }
    },

    async observeFunding(txid: string): Promise<LegFundingObservation> {
      const chronik = getChronikClient()
      const desc = parseActionDescriptor(txid)
      if (desc && desc.kind === 'swap-xec-watch-id') {
        const principalSats = BigInt(desc.extra || '0')
        const escrow = await openXecEscrowSdk(
          desc.swapId,
          desc.initiatorPub,
          desc.responderPub,
          chronik,
        )
        const script = chronik.script('p2pkh', escrow.pkhHex)
        const [utxoRes, histRes, info] = await Promise.all([
          script.utxos(),
          script.history(0, 200),
          chronik.blockchainInfo(),
        ])
        return xecEscrowFundingObservation({
          principalSats,
          escrowOutputScript: `76a914${escrow.pkhHex}88ac`,
          tipHeight: info.tipHeight,
          history: histRes.txs,
          unspentSats: utxoRes.utxos.reduce((sum, u) => sum + u.sats, 0n),
        })
      }

      const tx = await chronik.tx(txid).catch(() => null)
      if (!tx) {
        return { status: 'unseen', confirmations: 0 }
      }
      if (!tx.block) {
        // In the mempool: seen, but not yet in a block.
        return { status: 'unseen', txId: tx.txid, confirmations: 0 }
      }
      const { tipHeight } = await chronik.blockchainInfo()
      return {
        ...depthObservation(tipHeight - tx.block.height + 1),
        txId: tx.txid,
        blockHeight: tx.block.height,
        blockHash: tx.block.hash,
      }
    },

    async observeSettlement(input): Promise<LegSettlementObservation> {
      const desc = parseActionDescriptor(input.claimTxid)
      if (desc) {
        const role = desc.extra as SwapRole
        const xecRefunded = readLocalTag(
          `${XEC_REFUNDED_STORAGE_PREFIX}${desc.swapId}`,
        )
        const evmRefunded = readLocalTag(
          `${EVM_REFUNDED_STORAGE_PREFIX}${desc.swapId}`,
        )
        if (xecRefunded || (role === 'responder' && evmRefunded)) {
          return {
            effect: 'refund',
            status: 'final',
            txId: xecRefunded ?? evmRefunded ?? input.refundTxid,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
        const xecClaimed = readLocalTag(
          `${XEC_CLAIMED_STORAGE_PREFIX}${desc.swapId}`,
        )
        const evmClaimed = readLocalTag(
          `${EVM_CLAIMED_STORAGE_PREFIX}${desc.swapId}`,
        )
        if (xecClaimed || (role === 'initiator' && evmClaimed)) {
          return {
            effect: 'claim',
            status: 'final',
            txId: xecClaimed ?? evmClaimed ?? input.claimTxid,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
      }
      return { effect: 'none', status: 'unseen', confirmations: 0 }
    },

    async releaseInputs(swapId: string): Promise<void> {
      try {
        const { wallet } = await openUtxoWallet(
          TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
        )
        const ecashWallet = wallet as unknown as EcashWallet
        await ecashWallet.releaseNativeOperation(
          `swap-xec-fund:${swapId.toLowerCase()}`,
        )
      } catch {
        // Ignore if not reserved locally
      }
    },
  }
}

export function createLiveEvmSwapCapability(
  getEvmWallet: () => EvmChainWalletHandle,
): EvmSwapCapability {
  return {
    // A new swap cannot be funded (see `SwapExecutionDisabledError`).
    reserveInput: refuseNewSwapExecution,

    async broadcastTransaction(txHex: string) {
      const evmWallet = getEvmWallet()
      const desc = parseActionDescriptor(txHex)
      if (desc) {
        if (desc.kind === 'swap-evm-watch') {
          return { txHash: txHex }
        }
        if (desc.kind === 'swap-evm-claim' || desc.kind === 'swap-evm-refund') {
          const role = desc.extra as SwapRole
          const isClaim = desc.kind === 'swap-evm-claim'
          if (isClaim && role !== 'initiator') {
            return { txHash: txHex }
          }
          if (!isClaim && role !== 'responder') {
            return { txHash: txHex }
          }
          const prefix = isClaim
            ? EVM_CLAIMED_STORAGE_PREFIX
            : EVM_REFUNDED_STORAGE_PREFIX
          const existing = readLocalTag(`${prefix}${desc.swapId}`)
          if (existing) return { txHash: existing }

          const escrowPrivKey = deriveEvmEscrowPrivateKeyHex(
            desc.swapId,
            desc.initiatorPub,
            desc.responderPub,
          )
          const escrowSigner = new ethers.Wallet(
            escrowPrivKey,
            evmWallet.provider,
          )
          const balance = await evmWallet.provider.getBalance(
            escrowSigner.address,
          )
          const feeData = await evmWallet.provider.getFeeData()
          const gasPrice =
            feeData.maxFeePerGas ?? feeData.gasPrice ?? 100_000_000_000n
          const gasCost = 21_000n * gasPrice
          if (balance <= gasCost) {
            throw new Error('Insufficient funds in Monad swap escrow')
          }
          const sendWei = balance - gasCost
          const recipient = evmWallet.mainAccount?.address
          if (!recipient) throw new Error('The EVM wallet has no main account')
          const txSigner = new MonadAccountTxSigner({
            privateKey: escrowPrivKey,
            provider: evmWallet.provider,
            httpClient: evmWallet.httpClient,
          })
          const signed = await txSigner.buildAndSignTransfer(recipient, sendWei)
          const txHash = await evmWallet.httpClient
            .submitRawTransaction(signed.rawTx)
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err)
              if (/already known|nonce too low/i.test(msg)) {
                return signed.txHash
              }
              throw err
            })
          await evmWallet.provider
            .waitForTransaction(txHash, 1, 15_000)
            .catch(() => null)
          writeLocalTag(`${prefix}${desc.swapId}`, txHash)
          return { txHash }
        }
      }

      const parsedTx = ethers.Transaction.from(txHex)
      const txHash = await evmWallet.httpClient
        .submitRawTransaction(txHex)
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/already known|nonce too low/i.test(msg) && parsedTx.hash) {
            return parsedTx.hash
          }
          throw err
        })
      await evmWallet.provider
        .waitForTransaction(txHash, 1, 15_000)
        .catch(() => null)
      return { txHash }
    },

    async observeFunding(
      txHash: string,
      previous?: LegFundingObservation,
    ): Promise<LegFundingObservation> {
      const evmWallet = getEvmWallet()
      const desc = parseActionDescriptor(txHash)
      if (desc && desc.kind === 'swap-evm-watch-id') {
        const principalWei = BigInt(desc.extra || '0')
        const escrowPrivKey = deriveEvmEscrowPrivateKeyHex(
          desc.swapId,
          desc.initiatorPub,
          desc.responderPub,
        )
        return await observeEvmEscrowFunding(
          evmWallet.provider,
          new ethers.Wallet(escrowPrivKey).address,
          principalWei,
          previous,
        )
      }

      const receipt = await evmWallet.provider
        .getTransactionReceipt(txHash)
        .catch(() => null)
      if (!receipt || receipt.status !== 1) {
        return { status: 'unseen', confirmations: 0 }
      }
      const tip = await evmWallet.provider.getBlockNumber()
      return {
        ...depthObservation(tip - receipt.blockNumber + 1),
        txId: receipt.hash,
        blockHeight: receipt.blockNumber,
        blockHash: receipt.blockHash,
      }
    },

    async observeSettlement(input): Promise<LegSettlementObservation> {
      const desc = parseActionDescriptor(input.claimTxHash)
      if (desc) {
        const role = desc.extra as SwapRole
        const evmRefunded = readLocalTag(
          `${EVM_REFUNDED_STORAGE_PREFIX}${desc.swapId}`,
        )
        const xecRefunded = readLocalTag(
          `${XEC_REFUNDED_STORAGE_PREFIX}${desc.swapId}`,
        )
        if (evmRefunded || (role === 'initiator' && xecRefunded)) {
          return {
            effect: 'refund',
            status: 'final',
            txId: evmRefunded ?? xecRefunded ?? input.refundTxHash,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
        const evmClaimed = readLocalTag(
          `${EVM_CLAIMED_STORAGE_PREFIX}${desc.swapId}`,
        )
        const xecClaimed = readLocalTag(
          `${XEC_CLAIMED_STORAGE_PREFIX}${desc.swapId}`,
        )
        if (evmClaimed || (role === 'responder' && xecClaimed)) {
          return {
            effect: 'claim',
            status: 'final',
            txId: evmClaimed ?? xecClaimed ?? input.claimTxHash,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
      }
      return { effect: 'none', status: 'unseen', confirmations: 0 }
    },

    async releaseInput(): Promise<void> {
      // No pre-broadcast lock on EVM account nonce before funding exposure
    },
  }
}

let activeExecutionScope: object | undefined

/**
 * Both escrow keys built above derive from public data, so either peer can sweep both legs
 * (review A3). Until the swap is rebuilt on the HTLC contract, no new swap execution starts:
 * reserving inputs for a new swap refuses with this error. Swaps prepared earlier stay
 * readable so their deposits can still be refunded, claimed or reconciled.
 */
export class SwapExecutionDisabledError extends Error {
  constructor() {
    super('Atomic swap execution is turned off until it is rebuilt on HTLC')
    this.name = 'SwapExecutionDisabledError'
  }
}

async function refuseNewSwapExecution(): Promise<never> {
  throw new SwapExecutionDisabledError()
}

export function startAppSwapExecution(input: {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
}): { stop(): Promise<void> } {
  const mine = {}
  activeExecutionScope = mine
  if (
    activeChain.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier ||
    input.wallet.chainIdentifier !==
      TESTNET_NEGOTIATION_POLICY.evmChainIdentifier
  ) {
    return {
      stop: async () => {
        if (activeExecutionScope === mine) {
          activeExecutionScope = undefined
          installSwapExecutionCoordinator(null)
        }
      },
    }
  }

  let browserStore: BrowserSwapExecutionStore | undefined
  const stop = async () => {
    if (activeExecutionScope === mine) {
      activeExecutionScope = undefined
      installSwapExecutionCoordinator(null)
    }
    browserStore?.close()
  }

  // Swap records live only in this device's IndexedDB. Without it they cannot be kept or read
  // back, so nothing runs and the card says the records could not be opened; a swap funded
  // earlier is never shown as if there were none.
  try {
    if (typeof indexedDB === 'undefined') throw new Error('No IndexedDB')
    browserStore = new BrowserSwapExecutionStore(
      swapExecutionStoreNamespace(input),
    )
  } catch (error) {
    console.error('[swapExecution] swap records unavailable:', error)
    failSwapExecutionRestore('storage-unavailable')
    return { stop }
  }

  let owner: SwapExecutionOwner
  try {
    owner = appSwapExecutionOwner(input)
  } catch (error) {
    console.error('[swapExecution] swap record owner unavailable:', error)
    failSwapExecutionRestore('account-unavailable')
    return { stop }
  }

  const activeHolds = new Set<string>()
  const custody: SwapCustodyHoldCapability = {
    async acquireHold(operationId: string) {
      activeHolds.add(operationId)
      return { operationId }
    },
    async releaseHold(operationId: string) {
      activeHolds.delete(operationId)
    },
  }

  const evmWallet = input.wallet as unknown as EvmChainWalletHandle
  createSwapExecutionCoordinator({
    owner,
    store: browserStore,
    custody,
    xec: createLiveXecSwapCapability(),
    evm: createLiveEvmSwapCapability(() => evmWallet),
  })
  // A failed read is kept in `swapExecutionState.restore` and shown on the card.
  void refreshSwapExecutionRecords().catch(error =>
    console.error('[swapExecution] swap records unreadable:', error),
  )

  return { stop }
}

/** The IndexedDB namespace of a wallet's swap records on the active chain. */
export function swapExecutionStoreNamespace(input: {
  wallet: NativeWalletHandle
  revision: number
}): string {
  const rawAddress = input.wallet.identity.address?.raw ?? 'default'
  return (
    `${activeChain.chainIdentifier}:${rawAddress}:${input.revision}`
      .replace(/[^a-zA-Z0-9_:-]/g, '_')
      .slice(0, 128) || 'default'
  )
}

/**
 * The owner every swap record of this session is written and read under: the account's
 * negotiation incarnation and the wallet's compressed secp256k1 key. Derived only from the
 * custody receipt and the wallet, so every start of the same account computes the same one.
 */
export function appSwapExecutionOwner(input: {
  wallet: NativeWalletHandle
  revision: number
  account: unknown
}): SwapExecutionOwner {
  const accountIncarnation = appNegotiationIncarnation(
    input.revision,
    (input.account as PublicAccount).receipt,
  )
  const identity = input.wallet.identity as unknown as {
    compressedPubKey?: Uint8Array
  }
  if (!(identity.compressedPubKey instanceof Uint8Array))
    throw new TypeError('The wallet has no compressed public key')
  return {
    accountIncarnation,
    localPublicKey: toHex(identity.compressedPubKey),
  }
}
