import { Wallet } from 'ethers'
import { bip32MasterFromDomainRoot } from '../bip32-domain-root'
import { MONAD_IDENTITY_DERIVATION_PATH } from '../monad-identity'
import { MemoryRecordStore } from '../storage/evm-coin-store'
import { TempoPathUsdJournal, TempoPathUsdTransfers, type TempoPathUsdOperation, type TempoPathUsdRpc } from './tempo-pathusd-operation'
import { TempoPathUsdReceiveScanner, type TempoReceiveBatch } from './tempo-pathusd-receive'
import { TempoPathUsdMainAccount, TempoPathUsdWallet } from './tempo-pathusd-wallet'

const root = { purpose: 'evm-wallet' as const, bytes: Uint8Array.from({ length: 32 }, (_, i) => i + 1) }
const recipient = '0x2222222222222222222222222222222222222222'
const operationId = '0x' + 'aa'.repeat(32)
const blockHash = '0x' + 'bb'.repeat(32)

test('Tempo uses the existing EVM main account and a stable PathUSD receive cursor', async () => {
  const expected = new Wallet(bip32MasterFromDomainRoot(root, 'evm-wallet').derivePath(MONAD_IDENTITY_DERIVATION_PATH).privateKey)
  const account = TempoPathUsdMainAccount.fromDomainRoot(root)
  expect(account.source.address).toBe(expected.address.toLowerCase())
  const rpc: TempoPathUsdRpc = {
    verifyChain: async chain => { expect(chain).toBe('tempo-testnet') },
    getPendingNonce: async () => 0n,
    getFinalizedNonce: async () => 0n,
    getPathUsdBalance: async () => 2_000_000n,
    quoteTransfer: async () => ({ gasLimit: 100_000n, maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n }),
    sendRawTransaction: async () => { throw new Error('no broadcast in test') },
    getReceipt: async () => null,
    isFinalizedReceipt: async () => false,
  }
  const journal = new TempoPathUsdJournal(new MemoryRecordStore<TempoPathUsdOperation>())
  const transfers = new TempoPathUsdTransfers('tempo-testnet', journal, rpc, async (_source, task) => task())
  const receiveStore = new MemoryRecordStore<TempoReceiveBatch>()
  const receive = new TempoPathUsdReceiveScanner('tempo-testnet', receiveStore, {
    finalizedHead: async () => ({ number: 9n, hash: blockHash }),
    blockHash: async () => blockHash,
    receivedTransfers: async () => [],
  }, async (_recipient, task) => task())
  const wallet = new TempoPathUsdWallet('tempo-testnet', account, rpc, transfers, receive)
  expect(wallet.address).toBe(expected.address.toLowerCase())
  expect(await wallet.balanceAtomic()).toBe(2_000_000n)
  const quote = await wallet.quote(recipient, 1_000_000n)
  expect(quote.maximumFeeAtomic).toBe(200n)
  const prepared = await wallet.prepare({
    operationId, recipient, amountAtomic: 1_000_000n,
    authorizedFeeAsset: quote.feeAsset,
    authorizedFeeCeilingAtomic: quote.maximumFeeAtomic,
    quotedNonce: quote.nonce,
  })
  expect(prepared.source.address).toBe(expected.address.toLowerCase())
  expect(prepared.signedRaw).toBeNull()
  expect(await wallet.syncReceived()).toEqual({ nextBlock: 10n, delivered: 0 })
  expect(wallet.receivedItems()).toEqual([])
  const reopened = new TempoPathUsdWallet('tempo-testnet', account, rpc, transfers,
    new TempoPathUsdReceiveScanner('tempo-testnet', receiveStore, {
      finalizedHead: async () => ({ number: 9n, hash: blockHash }),
      blockHash: async () => blockHash,
      receivedTransfers: async () => { throw new Error('reopen must not rescan') },
    }, async (_recipient, task) => task()))
  expect(await reopened.syncReceived()).toEqual({ nextBlock: 10n, delivered: 0 })
  expect(reopened.receivedItems()).toEqual([])
})
