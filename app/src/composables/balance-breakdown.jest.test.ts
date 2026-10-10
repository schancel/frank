import { readBalanceBreakdown } from './balance-breakdown'

const MAIN = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa'
const PROFILE = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'

function wallet(over: Record<string, unknown> = {}) {
  const balances: Record<string, bigint> = { [MAIN]: 40n, [PROFILE]: 7n }
  return {
    identity: { address: { raw: PROFILE } },
    getReceiveAddress: async () => ({ raw: MAIN }),
    evmReader: { getBalance: async (address: string) => balances[address] },
    getReceivedPayments: () => [
      { spendable: true, amountWei: 10n },
      { spendable: true, amountWei: 20n },
      // Claimed by a message but not on the chain: never money.
      { spendable: false, amountWei: 0n },
    ],
    // Everything outside the main account: profile 7 + received 30 + 180 in sending accounts.
    getContractCallFunds: async () => ({
      mainBalance: 40n,
      otherBalance: 217n,
    }),
    ...over,
  }
}

describe('readBalanceBreakdown', () => {
  it('says where the money is: main account, profile address, received payments, the rest', async () => {
    expect(await readBalanceBreakdown(wallet())).toEqual({
      rows: [
        { id: 'main', amount: 40n, address: MAIN },
        { id: 'profile', amount: 7n, address: PROFILE },
        { id: 'received', amount: 30n, count: 2 },
        { id: 'other', amount: 180n },
      ],
      // The balance: every row but the sending accounts, which the wallet's figure leaves out.
      total: 77n,
    })
  })

  it('has no row for other accounts when the wallet does not report them', async () => {
    const breakdown = await readBalanceBreakdown(
      wallet({ getContractCallFunds: undefined }),
    )
    expect(breakdown.rows.map(row => row.id)).toEqual([
      'main',
      'profile',
      'received',
    ])
    expect(breakdown.total).toBe(77n)
  })

  it('has no row for other accounts when nothing is held beyond the rows already shown', async () => {
    const breakdown = await readBalanceBreakdown(
      wallet({
        getContractCallFunds: async () => ({
          mainBalance: 40n,
          otherBalance: 37n,
        }),
      }),
    )
    expect(breakdown.rows.map(row => row.id)).toEqual([
      'main',
      'profile',
      'received',
    ])
  })

  it('still shows the other rows while the wallet cannot account for its accounts', async () => {
    const breakdown = await readBalanceBreakdown(
      wallet({
        getContractCallFunds: async () => {
          throw new Error(
            'Native send is unavailable while pool funding remains pending',
          )
        },
      }),
    )
    expect(breakdown.rows[0]).toEqual({
      id: 'main',
      amount: 40n,
      address: MAIN,
    })
    expect(breakdown.rows.some(row => row.id === 'other')).toBe(false)
  })

  it('shows one account when the profile address is the main account, and no empty rows', async () => {
    const breakdown = await readBalanceBreakdown(
      wallet({
        identity: { address: { raw: MAIN.toLowerCase() } },
        getReceivedPayments: () => [],
        getContractCallFunds: async () => ({
          mainBalance: 40n,
          otherBalance: 0n,
        }),
      }),
    )
    expect(breakdown).toEqual({
      rows: [{ id: 'main', amount: 40n, address: MAIN }],
      total: 40n,
    })
  })

  it('has no rows for a wallet that answers none of this', async () => {
    expect(await readBalanceBreakdown({})).toEqual({ rows: [], total: 0n })
  })
})
