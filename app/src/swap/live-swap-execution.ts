/**
 * Live browser swap execution runtime for testnet (`xec-testnet` ↔ `monad-testnet`).
 *
 * Wires `SwapExecutionCoordinator` to `BrowserSwapExecutionStore` (or `InMemorySwapExecutionStore`
 * when `indexedDB` is unavailable), the session's `xec-testnet` `EcashWallet` + Chronik client,
 * and the session's `monad-testnet` `EvmChainWalletHandle` + `MonadAccountTxSigner`.
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
import type { EcashNativeOperation } from '@frank/wallet/ecash-operation-store'
import type { EcashSdkWallet } from '@frank/wallet/ecash-sdk-backend'
import { MonadAccountTxSigner } from '@frank/wallet/evm-account-tx'
import {
  InMemorySwapExecutionStore,
  SWAP_FINALITY_CONFIRMATIONS,
  type EvmSwapCapability,
  type LegFundingObservation,
  type LegSettlementObservation,
  type SwapCustodyHoldCapability,
  type SwapExecutionStore,
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
  installSwapExecutionCoordinator,
  refreshSwapExecutionRecords,
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
  const sdk = new WalletCtor(account.seckey(), chronik, account, 0, 'ectest')
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

function resolveParties(
  role: SwapRole | undefined,
  localPublicKey: string | undefined,
  peerPublicKey: string | undefined,
  swapId: string,
): { initiatorPub: string; responderPub: string; role: SwapRole } {
  const effectiveRole: SwapRole = role ?? 'initiator'
  const local = (localPublicKey ?? '02' + swapId.slice(0, 64)).toLowerCase()
  const peer = (peerPublicKey ?? '03' + swapId.slice(0, 64)).toLowerCase()
  return {
    role: effectiveRole,
    initiatorPub: effectiveRole === 'initiator' ? local : peer,
    responderPub: effectiveRole === 'initiator' ? peer : local,
  }
}

export function createLiveXecSwapCapability(): XecSwapCapability {
  return {
    async reserveInputs(input) {
      const { initiatorPub, responderPub, role } = resolveParties(
        input.role,
        input.localPublicKey,
        input.peerPublicKey,
        input.swapId,
      )
      const swapId = input.swapId.toLowerCase()
      const chronik = getChronikClient()
      const escrow = await openXecEscrowSdk(
        swapId,
        initiatorPub,
        responderPub,
        chronik,
      )

      const claimDesc = `swap-xec-claim:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const claimIdDesc = `swap-xec-claim-id:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const refundDesc = `swap-xec-refund:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const refundIdDesc = `swap-xec-refund-id:${swapId}:${initiatorPub}:${responderPub}:${role}`

      if (role === 'initiator') {
        const { wallet } = await openUtxoWallet(
          TESTNET_NEGOTIATION_POLICY.xecChainIdentifier,
        )
        await wallet.getBalance()
        const ecashWallet = wallet as unknown as EcashWallet
        const operationId = `swap-xec-fund:${swapId}`
        let op: EcashNativeOperation
        try {
          op = await ecashWallet.prepareNativeOperation({
            operationId,
            recipient: { raw: escrow.address },
            value: input.principalSats + XEC_SWEEP_FEE_BUFFER_SATS,
          })
        } catch {
          op = await ecashWallet.prepareNativeOperation({
            operationId,
            recipient: { raw: escrow.address },
            value: input.principalSats,
          })
        }
        return {
          inputs: op.inputs.map(i => ({
            txid: i.txid,
            vout: i.vout,
            valueSats: i.satoshis.toString(),
          })),
          feeSats: BigInt(op.fee),
          fundingTxHex: op.transactions[0].rawTransaction,
          fundingTxid: op.transactions[0].txid,
          claimTxHex: claimDesc,
          claimTxid: claimIdDesc,
          refundTxHex: refundDesc,
          refundTxid: refundIdDesc,
        }
      }

      // Responder watches the deterministic XEC escrow address funded by Initiator
      const watchDesc = `swap-xec-watch:${swapId}:${initiatorPub}:${responderPub}:${input.principalSats.toString()}`
      const watchIdDesc = `swap-xec-watch-id:${swapId}:${initiatorPub}:${responderPub}:${input.principalSats.toString()}`
      return {
        inputs: [
          {
            txid: escrow.pkhHex.padEnd(64, '0'),
            vout: 0,
            valueSats: input.principalSats.toString(),
          },
        ],
        feeSats: XEC_SWEEP_FEE_BUFFER_SATS,
        fundingTxHex: watchDesc,
        fundingTxid: watchIdDesc,
        claimTxHex: claimDesc,
        claimTxid: claimIdDesc,
        refundTxHex: refundDesc,
        refundTxid: refundIdDesc,
      }
    },

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
        const [utxoRes, histRes] = await Promise.all([
          chronik
            .script('p2pkh', escrow.pkhHex)
            .utxos()
            .catch(() => ({ utxos: [] })),
          chronik
            .script('p2pkh', escrow.pkhHex)
            .history(0, 25)
            .catch(() => ({ txs: [] })),
        ])
        const unspentSats = utxoRes.utxos.reduce(
          (sum, u) => sum + BigInt(u.sats),
          0n,
        )
        const hasHistory = Array.isArray(histRes.txs) && histRes.txs.length > 0
        if (unspentSats >= principalSats || hasHistory) {
          const observedTxid =
            utxoRes.utxos[0]?.outpoint.txid ?? histRes.txs?.[0]?.txid ?? txid
          return {
            status: 'final',
            txId: observedTxid,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
        return { status: 'unseen', confirmations: 0 }
      }

      const tx = await chronik.tx(txid).catch(() => null)
      if (!tx) {
        return { status: 'unseen', confirmations: 0 }
      }
      return {
        status: 'final',
        txId: tx.txid,
        confirmations: SWAP_FINALITY_CONFIRMATIONS,
        blockHeight: tx.block?.height,
        blockHash: tx.block?.hash,
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
    async reserveInput(input) {
      const { initiatorPub, responderPub, role } = resolveParties(
        input.role,
        input.localPublicKey,
        input.peerPublicKey,
        input.swapId,
      )
      const swapId = input.swapId.toLowerCase()
      const evmWallet = getEvmWallet()
      const escrowPrivKey = deriveEvmEscrowPrivateKeyHex(
        swapId,
        initiatorPub,
        responderPub,
      )
      const escrowWallet = new ethers.Wallet(escrowPrivKey)

      const claimDesc = `swap-evm-claim:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const claimIdDesc = `swap-evm-claim-id:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const refundDesc = `swap-evm-refund:${swapId}:${initiatorPub}:${responderPub}:${role}`
      const refundIdDesc = `swap-evm-refund-id:${swapId}:${initiatorPub}:${responderPub}:${role}`

      if (role === 'responder') {
        const feeData = await evmWallet.provider.getFeeData()
        const gasPrice =
          feeData.maxFeePerGas ?? feeData.gasPrice ?? 100_000_000_000n
        const sweepGasReserveWei = 21_000n * gasPrice * 2n
        const balance = await evmWallet.provider.getBalance(
          evmWallet.mainAccount.address,
        )
        if (balance < input.principalWei + 21_000n * gasPrice) {
          throw new Error('Insufficient funds')
        }
        const depositWei =
          balance >= input.principalWei + sweepGasReserveWei * 2n
            ? input.principalWei + sweepGasReserveWei
            : input.principalWei
        const signer = new MonadAccountTxSigner(
          evmWallet.mainAccount,
          evmWallet.httpClient,
          BigInt(evmWallet.config.chainId),
        )
        const signed = await signer.buildAndSignTransfer(
          escrowWallet.address,
          depositWei,
        )
        const feeBudgetWei = (
          signed.gasLimit * (signed.maxFeePerGas ?? signed.gasPrice ?? gasPrice)
        ).toString()
        return {
          input: {
            address: signed.from,
            nonce: signed.nonce,
            feeBudgetWei,
          },
          fundingTxHex: signed.rawTx,
          fundingTxHash: signed.txHash,
          claimTxHex: claimDesc,
          claimTxHash: claimIdDesc,
          refundTxHex: refundDesc,
          refundTxHash: refundIdDesc,
        }
      }

      // Initiator watches the deterministic EVM escrow address funded by Responder
      const watchDesc = `swap-evm-watch:${swapId}:${initiatorPub}:${responderPub}:${input.principalWei.toString()}`
      const watchIdDesc = `swap-evm-watch-id:${swapId}:${initiatorPub}:${responderPub}:${input.principalWei.toString()}`
      return {
        input: {
          address: escrowWallet.address,
          nonce: 0,
          feeBudgetWei: '0',
        },
        fundingTxHex: watchDesc,
        fundingTxHash: watchIdDesc,
        claimTxHex: claimDesc,
        claimTxHash: claimIdDesc,
        refundTxHex: refundDesc,
        refundTxHash: refundIdDesc,
      }
    },

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
          const txSigner = new MonadAccountTxSigner(
            escrowSigner,
            evmWallet.httpClient,
            BigInt(evmWallet.config.chainId),
          )
          const signed = await txSigner.buildAndSignTransfer(
            evmWallet.mainAccount.address,
            sendWei,
          )
          const txHash = await evmWallet.httpClient
            .sendRawTransaction(signed.rawTx)
            .catch(err => {
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
          await evmWallet.refreshBalance().catch(() => undefined)
          return { txHash }
        }
      }

      const parsedTx = ethers.Transaction.from(txHex)
      const txHash = await evmWallet.httpClient
        .sendRawTransaction(txHex)
        .catch(err => {
          const msg = err instanceof Error ? err.message : String(err)
          if (/already known|nonce too low/i.test(msg) && parsedTx.hash) {
            return parsedTx.hash
          }
          throw err
        })
      await evmWallet.provider
        .waitForTransaction(txHash, 1, 15_000)
        .catch(() => null)
      await evmWallet.refreshBalance().catch(() => undefined)
      return { txHash }
    },

    async observeFunding(txHash: string): Promise<LegFundingObservation> {
      const evmWallet = getEvmWallet()
      const desc = parseActionDescriptor(txHash)
      if (desc && desc.kind === 'swap-evm-watch-id') {
        const principalWei = BigInt(desc.extra || '0')
        const escrowPrivKey = deriveEvmEscrowPrivateKeyHex(
          desc.swapId,
          desc.initiatorPub,
          desc.responderPub,
        )
        const escrowWallet = new ethers.Wallet(escrowPrivKey)
        const [balance, nonce] = await Promise.all([
          evmWallet.provider.getBalance(escrowWallet.address).catch(() => 0n),
          evmWallet.provider
            .getTransactionCount(escrowWallet.address)
            .catch(() => 0),
        ])
        if (balance >= (principalWei * 90n) / 100n || nonce >= 1) {
          return {
            status: 'final',
            txId: escrowWallet.address,
            confirmations: SWAP_FINALITY_CONFIRMATIONS,
          }
        }
        return { status: 'unseen', confirmations: 0 }
      }

      const receipt = await evmWallet.provider
        .getTransactionReceipt(txHash)
        .catch(() => null)
      if (!receipt || receipt.status !== 1) {
        return { status: 'unseen', confirmations: 0 }
      }
      return {
        status: 'final',
        txId: receipt.hash,
        confirmations: SWAP_FINALITY_CONFIRMATIONS,
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
  let store: SwapExecutionStore
  if (typeof indexedDB !== 'undefined') {
    browserStore = new BrowserSwapExecutionStore()
    store = browserStore
  } else {
    store = new InMemorySwapExecutionStore()
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
    store,
    custody,
    xec: createLiveXecSwapCapability(),
    evm: createLiveEvmSwapCapability(() => evmWallet),
  })

  try {
    const accountIncarnation = appNegotiationIncarnation(
      input.revision,
      (input.account as PublicAccount).receipt,
    )
    const identity = input.wallet.identity as unknown as {
      compressedPubKey: Uint8Array
    }
    const localPublicKey = toHex(identity.compressedPubKey)
    void refreshSwapExecutionRecords({
      accountIncarnation,
      localPublicKey,
    }).catch(() => undefined)
  } catch {
    // ignore if receipt/identity not shaped for incarnation
  }

  return {
    stop: async () => {
      if (activeExecutionScope === mine) {
        activeExecutionScope = undefined
        installSwapExecutionCoordinator(null)
      }
      browserStore?.close()
    },
  }
}
