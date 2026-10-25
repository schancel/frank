/** Test double of the wallet's transaction-set capability for group writes: it keeps the
 * wallet's contract (one signed set per operation ID, replayed unchanged; construction never
 * broadcasts; authorization, release and chain reads recorded) and signs real transactions with a key that
 * holds no funds. Nothing reaches any chain. The real wallet's half is checked in
 * `write-payment.wallet.jest.test.ts`. */
import { Transaction, Wallet, getBytes, hexlify } from 'ethers'
import type {
  GroupWritePayer,
  GroupWritePreparedPayment,
} from './write-payment'

const NATIVE_CHAIN_IDS: Record<string, bigint> = {
  'monad-testnet': 10143n,
  'ethereum-sepolia': 11155111n,
}

export function groupWriteTestPayer(chainIdentifier = 'monad-testnet') {
  const key = new Wallet(`0x${'42'.repeat(32)}`)
  const sets = new Map<string, GroupWritePreparedPayment>()
  const events: string[] = []
  const wallet: GroupWritePayer = {
    chainIdentifier,
    async constructTransactionSet(request) {
      events.push(`construct:${request.maxRecipientTransactions}`)
      if (!request.independentRecipientTransactions)
        throw new Error('A group write payment must land on its own')
      // The wallet never builds a second set under a released operation.
      if (released.has(request.operationId))
        throw new Error(
          'Transaction-set operation ID conflicts with original intent',
        )
      const known = sets.get(request.operationId)
      if (known) return known
      const tx = Transaction.from({
        type: 2,
        chainId: NATIVE_CHAIN_IDS[chainIdentifier]!,
        nonce: sets.size,
        to: hexlify(request.kdf(0, 0)),
        value: request.amountAtomic,
        data: hexlify(request.calldata!),
        gasLimit: 60_000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      })
      tx.signature = key.signingKey.sign(tx.unsignedHash)
      const prepared = {
        operationId: request.operationId,
        chainIdentifier,
        bundle: [{ rawTransaction: getBytes(tx.serialized) }],
        otherTransactions: [],
      }
      sets.set(request.operationId, prepared)
      return prepared
    },
    async sendTransaction(prepared) {
      events.push(`send:${prepared.operationId}`)
      return { status: 'pending' }
    },
    async releaseTransactionSet(operationId) {
      events.push(`release:${operationId}`)
      // The wallet reads the chain first and keeps a payment the node holds.
      if (released.has(operationId)) return true
      if (!sets.has(operationId) || seenOnChain.has(operationId)) return false
      sets.delete(operationId)
      released.add(operationId)
      return true
    },
    async observeTransactionSet(operationId) {
      events.push(`observe:${operationId}`)
      return seenOnChain.has(operationId)
    },
  }
  const released = new Set<string>()
  /** Operations whose transaction the (simulated) node holds, so release must refuse. */
  const seenOnChain = new Set<string>()
  return { wallet, events, sets, seenOnChain }
}
