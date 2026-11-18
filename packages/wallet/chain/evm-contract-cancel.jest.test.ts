import { Transaction, Wallet } from 'ethers'
import { CANCELLATION_GAS, cancellationOf, isCancellationOf } from './evm-contract-cancel'

const signer = new Wallet('0x' + '11'.repeat(32))
const from = signer.address.toLowerCase()
const call = async (fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }, gasLimit = 200_000n) =>
  Transaction.from(
    await signer.signTransaction({
      type: 2,
      chainId: 10143n,
      nonce: 7,
      to: '0x' + '22'.repeat(20),
      value: 5n,
      data: '0x1234',
      gasLimit,
      ...fees,
    }),
  )

describe('cancelling a contract call at its nonce', () => {
  it('is a transfer of nothing to the account itself at the same nonce, with both fees bumped by a tenth', async () => {
    const original = await call({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
    const cancel = cancellationOf(original, from, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })!
    expect(cancel).toMatchObject({
      type: 2,
      chainId: 10143n,
      nonce: 7,
      value: 0n,
      data: '0x',
      gasLimit: CANCELLATION_GAS,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 11n,
    })
    expect(cancel.to!.toLowerCase()).toBe(from)
    expect(isCancellationOf(original, cancel, from)).toBe(true)
  })

  it('pays what the network asks now when that is more than the bump', async () => {
    const original = await call({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
    const cancel = cancellationOf(original, from, { maxFeePerGas: 500n, maxPriorityFeePerGas: 50n })!
    expect(cancel.maxFeePerGas).toBe(500n)
    expect(cancel.maxPriorityFeePerGas).toBe(50n)
  })

  it('is refused when giving the call up would cost more than the call was allowed to', async () => {
    const original = await call({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }, 21_000n)
    expect(cancellationOf(original, from, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })).toBeUndefined()
  })

  it('is not any other transaction at the nonce', async () => {
    const original = await call({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n })
    const cancel = cancellationOf(original, from, { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n })!
    const unlike = (change: Record<string, unknown>) =>
      isCancellationOf(original, Transaction.from({ ...cancel.toJSON(), ...change }), from)
    expect(unlike({ nonce: 8 })).toBe(false)
    expect(unlike({ value: 1n })).toBe(false)
    expect(unlike({ to: '0x' + '33'.repeat(20) })).toBe(false)
    expect(unlike({ data: '0x12' })).toBe(false)
    expect(unlike({ maxPriorityFeePerGas: 10n })).toBe(false)
    expect(unlike({ maxFeePerGas: 105n })).toBe(false)
    expect(unlike({ chainId: 1n })).toBe(false)
  })
})
