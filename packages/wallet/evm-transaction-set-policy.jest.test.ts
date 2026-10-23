import { EvmTransactionSetPolicyCache } from './evm-transaction-set-policy'

it.each(['ethereum', 'monad'])(
  'uses one cached fixed price for %s with economical dust and exact intrinsic calldata gas',
  async kind => {
    const provider = {
      getFeeData: jest.fn(async () => ({ gasPrice: 3n, maxFeePerGas: 99n })),
      getBlockNumber: jest.fn(async () => 100),
    }
    const cache = new EvmTransactionSetPolicyCache({
      provider: provider as never,
      kind,
      knownNoCodeAddress: '0x000000000000000000000000000000000000dead',
    })
    expect(() => cache.snapshot()).toThrow('not ready')
    await cache.refresh()
    const policy = cache.snapshot()
    expect(policy.gasPriceWei).toBe(3n)
    expect(policy.dustWei).toBe(630_000n)
    expect(
      policy.paymentGasLimit(
        '0x0001',
        '0x000000000000000000000000000000000000dead',
      ),
    ).toBe(21_050n)
    expect(policy.paymentGasLimit('0x')).toBe(21_000n)
    expect(() =>
      policy.paymentGasLimit(
        '0x01',
        '0x0000000000000000000000000000000000000001',
      ),
    ).toThrow('explicit reviewed')
    expect(provider.getFeeData).toHaveBeenCalledTimes(1)
    expect(provider.getBlockNumber).toHaveBeenCalledTimes(1)
  },
)

import { Wallet, Transaction } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { MemoryRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'

it.each(['monad', 'ethereum'])(
  'applies the production %s fee policy to subdust residue at a fresh recipient',
  async kind => {
    const source = new Wallet('0x' + '11'.repeat(32))
    const recipient = new Wallet('0x' + '22'.repeat(32))
    const burn = '0x000000000000000000000000000000000000dead'
    const cache = new EvmTransactionSetPolicyCache({
      provider: {
        getFeeData: async () => ({ gasPrice: 1n }),
        getBlockNumber: async () => 100,
      } as never,
      kind,
      knownNoCodeAddress: burn,
      spendSpacingBlocks: 3,
      reserveBalanceWei: 10n ** 19n,
    })
    await cache.refresh()
    async function prepare(destination: string) {
      const coins = await EvmCoinList.open(new MemoryRecordStore())
      await coins.put({
        account: source.address,
        privateKey: source.privateKey,
        nonce: 4,
        origin: 'stealth',
        valueWei: 321123n,
        lastSpentInBlock: 50,
      })
      const journal = new EvmNativeOperationJournal({
        testOnlyEphemeral: true,
        binding: {
          chainIdentifier:
            kind === 'monad' ? 'monad-testnet' : 'ethereum-sepolia',
          nativeChainId: kind === 'monad' ? '10143' : '11155111',
          publicTuple: 'fee-policy',
        },
      })
      await journal.Open()
      try {
        const preparer = new EvmTransactionSetPreparer({
          coins,
          journal,
          policy: () => cache.snapshot(),
          recoverySpendRule: { belowWei: 10n ** 19n, waitBlocks: 3 },
          deriveChange: index => {
            const wallet = new Wallet(
              '0x' + (100 + index).toString(16).padStart(64, '0'),
            )
            return {
              account: wallet.address,
              privateKey: wallet.privateKey,
              changeIndex: index,
            }
          },
        })
        const result = await preparer.constructTransactionSet({
          operationId: 'dust',
          amountWei: 300000n,
          kdf: () => destination,
        })
        return { result, row: preparer.getOperation('dust')! }
      } finally {
        await journal.Close()
      }
    }
    const eoa = await prepare(recipient.address)
    const knownBurn = await prepare(burn)
    // The source has already satisfied its quiet window. Its 123 wei remainder
    // cannot fund change, so it is gifted and the source is exhausted.
    expect(knownBurn.result.bundle[0]!.valueWei).toBe(300123n)
    expect(eoa.result.bundle[0]!.valueWei).toBe(300123n)
    expect(eoa.result.otherTransactions).toEqual([])
    expect(
      eoa.row.members.some(member => member.transactionSet?.refundPending),
    ).toBe(kind !== 'monad')
  },
)

it('uses the supported Monad calldata floor and conserves value across the signed burn, change, and all fixed fees', async () => {
  // Same byte/token counts as the rejected real Monad/0.16.4 Forum payload: 38 bytes,
  // one zero plus 37 nonzero bytes => 149 calldata tokens. Its accepted floor is 22,490.
  const calldata = '0x00' + '11'.repeat(37)
  const burn = '0x000000000000000000000000000000000000dead'
  const cache = new EvmTransactionSetPolicyCache({
    provider: {
      getFeeData: async () => ({ gasPrice: 3n }),
      getBlockNumber: async () => 100,
    } as never,
    kind: 'monad',
    knownNoCodeAddress: burn,
  })
  await cache.refresh()
  const source = new Wallet('0x' + '33'.repeat(32))
  const sourceValue = 1_367_593n
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  await coins.put({
    account: source.address,
    privateKey: source.privateKey,
    nonce: 0,
    origin: 'stealth',
    valueWei: sourceValue,
  })
  const journal = new EvmNativeOperationJournal({
    testOnlyEphemeral: true,
    binding: {
      chainIdentifier: 'monad-regtest',
      nativeChainId: '20143',
      publicTuple: 'monad-calldata-floor',
    },
  })
  await journal.Open()
  try {
    const preparer = new EvmTransactionSetPreparer({
      coins,
      journal,
      policy: () => cache.snapshot(),
      deriveChange: index => {
        const child = new Wallet(
          '0x' + (100 + index).toString(16).padStart(64, '0'),
        )
        return {
          account: child.address,
          privateKey: child.privateKey,
          changeIndex: index,
        }
      },
    })
    const result = await preparer.constructTransactionSet({
      operationId: 'forum-floor',
      amountWei: 300000n,
      kdf: () => burn,
      calldata,
    })
    expect(result.bundle[0]!.gasLimit).toBe(22490n)
    expect(result.otherTransactions.length).toBeGreaterThan(0)
    const signed = [...result.bundle, ...result.otherTransactions].map(member =>
      Transaction.from(member.rawTransaction),
    )
    expect(signed.find(tx => tx.to?.toLowerCase() === burn)!.data).toBe(
      calldata,
    )
    expect(
      signed.reduce(
        (sum, tx) => sum + tx.value + tx.gasLimit * tx.gasPrice!,
        0n,
      ),
    ).toBe(sourceValue)
    expect(signed.every(tx => tx.gasPrice === 3n)).toBe(true)
  } finally {
    await journal.Close()
  }
})
