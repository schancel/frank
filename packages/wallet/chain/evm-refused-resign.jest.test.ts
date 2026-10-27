import { Transaction, Wallet } from 'ethers'
import {
  isNodeRefusal,
  isResigningOf,
  MAX_SIGNINGS,
  REFUSALS_BEFORE_RESIGN,
  RefusalLedger,
  RESIGN_AFTER_MS,
  resignedTransaction,
} from './evm-refused-resign'

const signer = new Wallet('0x' + '11'.repeat(32))
const base = {
  chainId: 20143n,
  nonce: 3,
  to: '0x' + '22'.repeat(20),
  value: 5n * 10n ** 18n,
  gasLimit: 21000n,
}
const nodeRefusal = Object.assign(new Error('could not coalesce error'), {
  code: 'UNKNOWN_ERROR',
  error: { code: -32603, message: 'Signer had insufficient balance' },
})

test('a legacy transaction is signed again as the same transaction with only a lower tip', () => {
  const previous = Transaction.from({ ...base, type: 0, gasPrice: 102n * 10n ** 9n })
  const again = resignedTransaction(previous)
  expect(again.type).toBe(2)
  expect([again.chainId, again.nonce, again.to, again.value, again.data, again.gasLimit]).toEqual([
    previous.chainId, previous.nonce, previous.to, previous.value, previous.data, previous.gasLimit,
  ])
  // The most it can cost is what the first signing could cost.
  expect(again.maxFeePerGas).toBe(previous.gasPrice)
  expect(again.maxPriorityFeePerGas).toBe(previous.gasPrice! - 1n)
  expect(isResigningOf(previous, again)).toBe(true)
  const third = resignedTransaction(again)
  expect(third.maxFeePerGas).toBe(previous.gasPrice)
  expect(third.maxPriorityFeePerGas).toBe(previous.gasPrice! - 2n)
  expect(isResigningOf(again, third)).toBe(true)
  expect(isResigningOf(previous, third)).toBe(true)
  expect(isResigningOf(third, again)).toBe(false)
})

test('an EIP-1559 transaction keeps its fee ceiling; one whose tip is zero is not signed again', async () => {
  const previous = Transaction.from({ ...base, type: 2, maxFeePerGas: 202n, maxPriorityFeePerGas: 2n })
  const again = resignedTransaction(previous)
  expect(again.maxFeePerGas).toBe(202n)
  expect(again.maxPriorityFeePerGas).toBe(1n)
  const signed = Transaction.from(await signer.signTransaction(again))
  expect(signed.hash).not.toBe(Transaction.from(await signer.signTransaction(previous)).hash)
  expect(() =>
    resignedTransaction(Transaction.from({ ...base, type: 2, maxFeePerGas: 202n, maxPriorityFeePerGas: 0n })),
  ).toThrow()
})

test('anything but a lower tip is not a re-signing', () => {
  const previous = Transaction.from({ ...base, type: 0, gasPrice: 100n })
  const again = resignedTransaction(previous)
  for (const change of [
    { value: base.value + 1n },
    { nonce: base.nonce + 1 },
    { to: '0x' + '33'.repeat(20) },
    { gasLimit: base.gasLimit + 1n },
    { maxFeePerGas: 101n },
    { maxPriorityFeePerGas: 100n },
    { chainId: 1n },
    { data: '0x01' },
  ]) {
    const changed = Transaction.from({ ...again.toJSON(), ...change })
    expect(isResigningOf(previous, changed)).toBe(false)
  }
})

test('only the node refusing counts; an unanswered or duplicate broadcast does not', () => {
  expect(isNodeRefusal(nodeRefusal)).toBe(true)
  expect(isNodeRefusal(Object.assign(new Error('timeout'), { code: 'TIMEOUT' }))).toBe(false)
  expect(isNodeRefusal(new Error('ambiguous node response'))).toBe(false)
  expect(
    isNodeRefusal(Object.assign(new Error('x'), { error: { code: -32000, message: 'nonce too low' } })),
  ).toBe(false)
  expect(
    isNodeRefusal(Object.assign(new Error('x'), { error: { code: -32000, message: 'already known' } })),
  ).toBe(false)
})

test('a transaction is due to be signed again after the threshold, over the delay, up to the limit', () => {
  const delay = RESIGN_AFTER_MS.value
  try {
    RESIGN_AFTER_MS.value = 0
    const ledger = new RefusalLedger()
    for (let n = 1; n < REFUSALS_BEFORE_RESIGN; n++) ledger.note('0xaa', nodeRefusal)
    expect(ledger.due('0xaa', 1)).toBe(false)
    ledger.note('0xaa', nodeRefusal)
    expect(ledger.due('0xaa', 1)).toBe(true)
    expect(ledger.due('0xaa', MAX_SIGNINGS)).toBe(false)
    // An accepted broadcast clears the count.
    ledger.note('0xaa')
    expect(ledger.due('0xaa', 1)).toBe(false)
    RESIGN_AFTER_MS.value = 60_000
    for (let n = 0; n < REFUSALS_BEFORE_RESIGN; n++) ledger.note('0xbb', nodeRefusal)
    expect(ledger.due('0xbb', 1)).toBe(false)
  } finally {
    RESIGN_AFTER_MS.value = delay
  }
})
