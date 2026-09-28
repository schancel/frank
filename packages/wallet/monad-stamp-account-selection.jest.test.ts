import { selectStampAccounts } from './monad-stamp-account-selection'

const account = (index: number, capacityWei: bigint) => ({
  index,
  address: `0x${index.toString(16).padStart(40, '0')}`,
  capacityWei,
})

describe('selectStampAccounts', () => {
  it('does not manufacture an equal split from two oversized accounts', () => {
    expect(
      selectStampAccounts({
        amountWei: 100n,
        accounts: [account(0, 100n), account(1, 100n)],
      }).map(selected => selected.paymentValueWei),
    ).toEqual([100n])
  })

  it('uses the greatest lower bound repeatedly when segmented accounts can meet the soft two-payment goal', () => {
    expect(
      selectStampAccounts({
        amountWei: BigInt(100),
        accounts: [
          account(0, BigInt(20)),
          account(1, BigInt(45)),
          account(2, BigInt(55)),
        ],
      }).map(({ index, paymentValueWei }) => ({ index, paymentValueWei })),
    ).toEqual([
      { index: 1, paymentValueWei: BigInt(45) },
      { index: 0, paymentValueWei: BigInt(20) },
      { index: 2, paymentValueWei: BigInt(35) },
    ])
  })

  it('allows one smallest-upper-bound account as a valid fallback', () => {
    expect(
      selectStampAccounts({
        amountWei: BigInt(100),
        accounts: [account(0, BigInt(120))],
      }),
    ).toMatchObject([{ index: 0, paymentValueWei: BigInt(100) }])
  })

  it('never equal-splits accounts merely to reach two transactions', () => {
    const selected = selectStampAccounts({
      amountWei: BigInt(100),
      accounts: [account(0, BigInt(30)), account(1, BigInt(80))],
    })
    expect(selected.map(item => item.paymentValueWei)).toEqual([
      BigInt(30),
      BigInt(70),
    ])
  })

  it('rejects insufficient aggregate spendable capacity', () => {
    expect(() =>
      selectStampAccounts({
        amountWei: BigInt(100),
        accounts: [account(0, BigInt(30)), account(1, BigInt(60))],
      }),
    ).toThrow('need 100 wei, have 90 wei')
  })

  it('keeps a feasible right-sized account when applying a transaction cap', () => {
    const accounts = Array.from({ length: 64 }, (_, index) =>
      account(index, 1n),
    )
    accounts.push(account(64, 100n))

    const selected = selectStampAccounts({
      amountWei: 100n,
      accounts,
      maxTransactions: 64,
    })

    expect(selected.length).toBeLessThanOrEqual(64)
    expect(selected.reduce((sum, item) => sum + item.paymentValueWei, 0n)).toBe(
      100n,
    )
    expect(selected.some(item => item.index === 64)).toBe(true)
  })
})
