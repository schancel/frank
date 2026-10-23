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

describe('minimum-constrained source feasibility', () => {
  const sourceOrder = ['stealth', 'stamp', 'root', 'identity'] as const
  async function inventory(values: bigint[]) {
    const coins = await EvmCoinList.open(new MemoryRecordStore())
    for (const [index, valueWei] of values.entries()) {
      const signer = new Wallet('0x' + (index + 100).toString(16).padStart(64, '0'))
      await coins.put({ account: signer.address, privateKey: signer.privateKey,
        nonce: 0, valueWei, origin: sourceOrder[Math.min(index, 3)]! })
    }
    return coins
  }
  const request = { holder: 'feasible', amountWei: 250n, minimumPaymentWei: 100n,
    feeWei: 1n, head: 1, sourceOrder }

  it('reconsiders a preferred input that prevents an otherwise feasible two-part payment', async () => {
    const coins = await inventory([101n, 141n, 141n])
    const selected = coins.reserveTransactionSetSources(request)!
    expect(selected.map(part => part.coin.origin)).toEqual(['stamp', 'root'])
    expect(selected.map(part => part.paymentValueWei)).toEqual([140n, 110n])
    expect(coins.all().find(coin => coin.origin === 'stealth')!.state).toBe('unspent')
    expect(selected.every(part => part.coin.holder === request.holder)).toBe(true)
  })

  it('keeps the preferred input when a valid preferred partition exists', async () => {
    const coins = await inventory([111n, 141n, 201n])
    const selected = coins.reserveTransactionSetSources(request)!
    expect(selected.map(part => part.coin.origin)).toEqual(['stealth', 'stamp'])
    expect(selected.map(part => part.paymentValueWei)).toEqual([110n, 140n])
    expect(coins.all().find(coin => coin.origin === 'root')!.state).toBe('unspent')
  })

  it('uses each recipient index fee and capacity when reconsidering and redistributing the tail', async () => {
    const coins = await inventory([101n, 181n, 181n])
    const feeWei = jest.fn((index: number) => index === 0 ? 1n : 21n)
    const capacityWei = jest.fn((coin: { valueWei: bigint }, fee: bigint) =>
      coin.valueWei - fee - (coin.valueWei === 181n ? 20n : 0n))
    const selected = coins.reserveTransactionSetSources({ ...request, feeWei, capacityWei })!
    expect(selected.map(part => part.coin.origin)).toEqual(['stamp', 'root'])
    expect(selected.map(part => part.paymentValueWei)).toEqual([150n, 100n])
    expect(feeWei.mock.calls.map(([index]) => index)).toEqual([0, 1])
    expect(capacityWei.mock.calls.length).toBeLessThanOrEqual(3 * 2)
    expect(selected.reduce((sum, part) => sum + part.paymentValueWei, 0n)).toBe(request.amountWei)
  })

  it('bounds failed feasibility work by candidates times part slots and reserves nothing', async () => {
    const coins = await inventory(Array<bigint>(40).fill(101n))
    const before = coins.all()
    const feeWei = jest.fn(() => 1n)
    const capacityWei = jest.fn((coin: { valueWei: bigint }, fee: bigint) => coin.valueWei - fee)
    expect(coins.reserveTransactionSetSources({ ...request, feeWei, capacityWei })).toBeUndefined()
    expect(feeWei).toHaveBeenCalledTimes(2)
    expect(capacityWei.mock.calls.length).toBeLessThanOrEqual(40 * 2)
    expect(coins.all()).toEqual(before)
    expect(coins.heldBy(request.holder)).toEqual([])
  })
})
