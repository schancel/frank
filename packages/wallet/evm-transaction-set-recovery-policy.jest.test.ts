import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Wallet, Transaction, FeeData } from 'ethers'
import { EvmCoinList, type StoredEvmListCoin } from './evm-coin-list'
import { LevelRecordStore } from './storage/evm-coin-store'
import { EvmNativeOperationJournal } from './storage/evm-native-operation-journal'
import { EvmTransactionSetPreparer } from './evm-transaction-set'
import { EvmTransactionSetPolicyCache } from './evm-transaction-set-policy'

const signer = (index: number) =>
  new Wallet('0x' + index.toString(16).padStart(64, '0'))
const recoverySpendRule = { belowWei: 1000000n, waitBlocks: 3 }

it.each(['source residual', 'owned change'] as const)(
  'projects a known included %s after durable reopen without a fresh economic quote',
  async scenario => {
    const directory = await mkdtemp(
      join(tmpdir(), 'frank-recovery-static-rule-'),
    )
    const binding = {
      chainIdentifier: 'monad-testnet',
      nativeChainId: '10143',
      publicTuple: 'static-recovery-rule',
    }
    let store = await LevelRecordStore.open<StoredEvmListCoin>(
      directory,
      'coins',
    )
    let coins = await EvmCoinList.open(store)
    let journal = new EvmNativeOperationJournal({
      location: directory,
      binding,
    })
    await journal.Open()
    const destination = signer(50).address.toLowerCase()
    const deriveChange = (index: number) => ({
      account: signer(100 + index).address.toLowerCase(),
      privateKey: signer(100 + index).privateKey,
      changeIndex: index,
    })
    const warm = new EvmTransactionSetPolicyCache({
      kind: 'monad',
      knownNoCodeAddress: destination,
      spendSpacingBlocks: 3,
      reserveBalanceWei: recoverySpendRule.belowWei,
      provider: {
        getFeeData: jest.fn(async () => new FeeData(1n, 1n, 1n)),
        getBlockNumber: jest.fn(async () => 100),
      },
    })
    try {
      await warm.refresh()
      await coins.put({
        account: signer(1).address,
        privateKey: signer(1).privateKey,
        nonce: 0,
        valueWei: scenario === 'source residual' ? 121000n : 100000000n,
        origin: 'stealth',
      })
      const initial = new EvmTransactionSetPreparer({
        coins,
        journal,
        policy: () => warm.snapshot(),
        recoverySpendRule,
        deriveChange,
        random: () => 0.5,
      })
      await initial.constructTransactionSet({
        operationId: 'original',
        amountWei: 100000n,
        kdf: () => destination,
      })
      const row = initial.getOperation('original')!
      const memberIndex =
        scenario === 'source residual'
          ? 0
          : row.members.findIndex(
              member =>
                member.transactionSet?.role === 'change' &&
                BigInt(member.transactionSet.balanceBeforeWei) > 0n &&
                BigInt(member.transactionSet.balanceBeforeWei) -
                  BigInt(member.transactionSet.balanceAfterWei) -
                  21000n <
                  recoverySpendRule.belowWei,
            )
      expect(memberIndex).toBeGreaterThanOrEqual(0)
      const member = row.members[memberIndex]!
      const signed = member.signed!.rawTransaction
      await journal.Close()
      await store.close()
      store = await LevelRecordStore.open(directory, 'coins')
      coins = await EvmCoinList.open(store)
      journal = new EvmNativeOperationJournal({ location: directory, binding })
      await journal.Open()
      const coldProvider = {
        getFeeData: jest.fn(async () => {
          throw new Error('fee RPC unavailable')
        }),
        getBlockNumber: jest.fn(async () => {
          throw new Error('head RPC unavailable')
        }),
      }
      const cold = new EvmTransactionSetPolicyCache({
        kind: 'monad',
        knownNoCodeAddress: destination,
        spendSpacingBlocks: 3,
        reserveBalanceWei: recoverySpendRule.belowWei,
        provider: coldProvider,
      })
      const quote = jest.fn(() => cold.snapshot())
      const reopened = new EvmTransactionSetPreparer({
        coins,
        journal,
        policy: quote,
        recoverySpendRule,
        deriveChange,
      })
      const tx = Transaction.from(signed),
        blockHash = '0x' + '11'.repeat(32)
      await reopened.recordObservation(
        'original',
        memberIndex,
        {
          state: 'included-success',
          transactionHash: member.signed!.transactionHash,
          blockHash,
          blockNumber: 101,
          transactionIndex: memberIndex,
          feeWei: '21000',
        },
        {
          blockHash,
          blockNumber: 101,
          nonce: tx.nonce + 1,
          balanceWei:
            scenario === 'source residual'
              ? '5555'
              : member.transactionSet!.balanceAfterWei,
        },
      )
      const applied =
        scenario === 'source residual'
          ? coins.get(tx.from!, tx.nonce + 1)
          : coins.get(tx.to!, 0)
      expect(applied?.valueWei).toBe(
        scenario === 'source residual' ? 5555n : tx.value,
      )
      expect(applied?.spendableFromBlock).toBe(104)
      expect(
        reopened.getOperation('original')!.members[memberIndex]!.transactionSet
          ?.inventoryApplied,
      ).toBe(true)
      expect(
        reopened.getOperation('original')!.members[memberIndex]!.signed!
          .rawTransaction,
      ).toBe(signed)
      expect(quote).not.toHaveBeenCalled()
      expect(coldProvider.getFeeData).not.toHaveBeenCalled()
      expect(coldProvider.getBlockNumber).not.toHaveBeenCalled()
      await expect(
        reopened.constructTransactionSet({
          operationId: 'new-construction',
          amountWei: 1n,
          kdf: () => destination,
        }),
      ).rejects.toThrow('fee quote is not ready')
    } finally {
      await journal.Close()
      await store.close()
      await rm(directory, { recursive: true, force: true })
    }
  },
)
