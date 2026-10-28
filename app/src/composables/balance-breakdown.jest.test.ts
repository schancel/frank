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

describe('unsupported typed balance parts', () => {
  it.each([
    ['legacy quote and known addresses', wallet()],
    [
      'known addresses without a quote',
      wallet({ getContractCallFunds: undefined }),
    ],
    [
      'a quote with no other funds',
      wallet({
        getContractCallFunds: async () => ({
          mainBalance: 40n,
          otherBalance: 37n,
        }),
      }),
    ],
    [
      'a failing quote',
      wallet({
        getContractCallFunds: async () => {
          throw new Error('pending')
        },
      }),
    ],
    [
      'one address shared by main and profile',
      wallet({ identity: { address: { raw: MAIN.toLowerCase() } } }),
    ],
    ['no balance interfaces', {}],
  ])(
    'reports unavailable, never a zero or partial owned total: %s',
    async (_label, handle) => {
      expect(await readBalanceBreakdown(handle)).toBeUndefined()
    },
  )
  it('does not call an unrelated payment quote to synthesize ownership', async () => {
    const quote = jest
      .fn()
      .mockRejectedValue(new Error('not an ownership observation'))
    expect(
      await readBalanceBreakdown(wallet({ getContractCallFunds: quote })),
    ).toBeUndefined()
    expect(quote).not.toHaveBeenCalled()
  })
})

// Seen in Chrome on testnet: the balance shown was not what sends drew on, and the breakdown's
// rows did not add up to it.
describe('a wallet that gives its balance in parts', () => {
  it('shows exactly those parts as rows, adding up to the wallet balance; an empty part has no row', async () => {
    const wallet = {
      identity: { address: { raw: '0x' + 'bb'.repeat(20) } },
      getReceiveAddress: async () => ({ raw: '0x' + 'aa'.repeat(20) }),
      getBalance: async () => 12n + 22n + 50n + 21n,
      getBalanceParts: async () => ({
        main: 12n,
        profile: 22n,
        received: 50n,
        receivedCount: 3,
        sending: 21n,
      }),
      // Not consulted when the wallet gives its parts.
      getContractCallFunds: async () => {
        throw new Error('not read')
      },
    }
    const breakdown = await readBalanceBreakdown(wallet)
    expect(breakdown.rows).toEqual([
      { id: 'main', amount: 12n, address: '0x' + 'aa'.repeat(20) },
      { id: 'profile', amount: 22n, address: '0x' + 'bb'.repeat(20) },
      { id: 'received', amount: 50n, count: 3 },
      { id: 'other', amount: 21n },
    ])
    expect(breakdown.total).toBe(await wallet.getBalance())
    const bare = await readBalanceBreakdown({
      ...wallet,
      getBalanceParts: async () => ({
        main: 7n,
        profile: 0n,
        received: 0n,
        receivedCount: 0,
        sending: 0n,
      }),
    })
    expect(bare.rows.map(row => row.id)).toEqual(['main'])
    expect(bare.total).toBe(7n)
  })

  it('lists below-floor received value as a subset already counted in the total', async () => {
    // Two received stamps of 0.0021 MON: below ten moves of them, so not spendable money.
    const dust = 2_100_000_000_000_000n
    const wallet = {
      getReceiveAddress: async () => ({ raw: '0x' + 'aa'.repeat(20) }),
      getBalance: async () => 12n + 50n + 2n * dust,
      getBalanceParts: async () => ({
        main: 12n,
        profile: 0n,
        received: 50n + 2n * dust,
        receivedCount: 3,
        sending: 0n,
        tooSmall: 2n * dust,
        tooSmallCount: 2,
      }),
    }
    const breakdown = await readBalanceBreakdown(wallet)
    expect(breakdown.rows).toEqual([
      { id: 'main', amount: 12n, address: '0x' + 'aa'.repeat(20) },
      { id: 'received', amount: 50n + 2n * dust, count: 3 },
      { id: 'tooSmall', amount: 2n * dust, count: 2 },
    ])
    expect(breakdown!.total).toBe(62n + 2n * dust)
    expect(breakdown.total).toBe(await wallet.getBalance())
  })
})
