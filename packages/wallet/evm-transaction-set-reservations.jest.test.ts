import { Wallet } from 'ethers'
import { EvmCoinList } from './evm-coin-list'
import { MemoryRecordStore } from './storage/evm-coin-store'

it('reserves independent sources synchronously with stealth value and change index ordering', async () => {
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  for (const [index, valueWei] of [100n, 300n, 200n].entries()) {
    const signer = new Wallet('0x' + (index + 1).toString(16).padStart(64, '0'))
    await coins.put({
      account: signer.address,
      privateKey: signer.privateKey,
      nonce: 0,
      valueWei,
      origin: 'stealth',
    })
  }
  const first = coins.reserveTransactionSetSources({
    holder: 'a',
    amountWei: 350n,
    feeWei: 10n,
    head: 1,
    sourceOrder: ['stealth'],
  })!
  expect(first.map(part => part.coin.valueWei)).toEqual([300n, 200n])
  expect(first.map(part => part.paymentValueWei)).toEqual([290n, 60n])
  const second = coins.reserveTransactionSetSources({
    holder: 'b',
    amountWei: 50n,
    feeWei: 10n,
    head: 1,
    sourceOrder: ['stealth'],
  })!
  expect(second.map(part => part.coin.valueWei)).toEqual([100n])
  expect(
    coins.reserveTransactionSetSources({
      holder: 'c',
      amountWei: 1n,
      feeWei: 10n,
      head: 1,
      sourceOrder: ['stealth'],
    }),
  ).toBeUndefined()
})

it('selects change in index order before valid root and identity fallbacks', async () => {
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  const rows = [
    { origin: 'root' as const, valueWei: 1000n },
    { origin: 'identity' as const, valueWei: 2000n },
    { origin: 'change' as const, valueWei: 100n, changeIndex: 9 },
    { origin: 'change' as const, valueWei: 50n, changeIndex: 2 },
  ]
  for (const [index, row] of rows.entries()) {
    const signer = new Wallet(
      '0x' + (index + 20).toString(16).padStart(64, '0'),
    )
    await coins.put({
      account: signer.address,
      privateKey: signer.privateKey,
      nonce: 0,
      ...row,
    })
  }
  const picked = coins.reserveTransactionSetSources({
    holder: 'fallback',
    amountWei: 1200n,
    feeWei: 10n,
    head: 1,
    sourceOrder: [
      'stealth',
      'stamp',
      'change',
      'deterministic',
      'root',
      'identity',
    ],
  })!
  expect(picked.map(part => [part.coin.origin, part.coin.changeIndex])).toEqual(
    [
      ['change', 2],
      ['change', 9],
      ['root', undefined],
      ['identity', undefined],
    ],
  )
  expect(picked.reduce((sum, part) => sum + part.paymentValueWei, 0n)).toBe(
    1200n,
  )
})


it('finds a sufficient one-burn source after smaller change coins without reserving them', async () => {
  const coins = await EvmCoinList.open(new MemoryRecordStore())
  for (const [index, valueWei] of [100n, 1000n].entries()) {
    const signer = new Wallet('0x' + (index + 40).toString(16).padStart(64, '0'))
    await coins.put({ account: signer.address, privateKey: signer.privateKey,
      nonce: 0, valueWei, origin: index === 0 ? 'change' : 'root',
      ...(index === 0 ? { changeIndex: 0 } : {}) })
  }
  const selected = coins.reserveTransactionSetSources({ holder: 'one-burn',
    amountWei: 500n, feeWei: 10n, head: 1, maxCoins: 1,
    sourceOrder: ['change', 'root'] })
  expect(selected).toHaveLength(1)
  expect(selected![0]!.coin.origin).toBe('root')
  expect(coins.all().find(coin => coin.origin === 'change')!.state).toBe('unspent')
})
