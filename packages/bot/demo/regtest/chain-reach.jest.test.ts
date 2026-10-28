import { describeRanges, followTransfers, notTheWallets, REGTEST_GROUP_WRITE_PAYEE, type ReachBlock } from './chain-reach'

const wallet = '0x' + 'aa'.repeat(20)
const change = '0x' + 'bb'.repeat(20)
const unknown = '0x' + 'cc'.repeat(20)
const dead = '0x000000000000000000000000000000000000dEaD'
const relayPayee = '0x' + 'dd'.repeat(20)
const faucet = '0x' + 'ee'.repeat(20)

const tx = (from: string, to: string, value = '0x1') => ({ from, to, value })

describe('followTransfers', () => {
  it('follows transfers through reached accounts and names the ones whose keys were not found', () => {
    const blocks: ReachBlock[] = [
      { number: 11, block: { transactions: [tx(change, unknown)] } },
      { number: 10, block: { transactions: [tx(wallet, change), tx(faucet, wallet)] } },
    ]
    const { reached, missing } = followTransfers(blocks, [wallet], [faucet])
    expect([...reached].sort()).toEqual([change, unknown].sort())
    expect(missing).toEqual([])
  })

  it('does not count the stack relays\' group-write payee, the burn address or a policy payee as accounts the wallet lost', () => {
    const blocks: ReachBlock[] = [
      { number: 1, block: { transactions: [tx(wallet, REGTEST_GROUP_WRITE_PAYEE), tx(wallet, dead), tx(wallet, relayPayee.toUpperCase().replace('0X', '0x'))] } },
      { number: 2, block: { transactions: [tx(relayPayee, unknown), tx(faucet, unknown)] } },
    ]
    const excluded = notTheWallets(faucet, dead, [relayPayee])
    expect(excluded.has(REGTEST_GROUP_WRITE_PAYEE.toLowerCase())).toBe(true)
    const { reached, missing } = followTransfers(blocks, [wallet], excluded)
    expect([...reached]).toEqual([])
    expect(missing).toEqual([])
    // Without the exclusions every payee would be named as holding the wallet's money.
    expect(followTransfers(blocks, [wallet], [faucet]).reached.size).toBe(3)
  })

  it('reports blocks the node no longer has as ranges, so the caller cannot call the funds returned', () => {
    const blocks: ReachBlock[] = [
      { number: 5, block: { transactions: [] } },
      { number: 6, block: null },
      { number: 7, block: null },
      { number: 8, block: null },
      { number: 9, block: { transactions: [tx(wallet, change)] } },
      { number: 10, block: null },
    ]
    const { reached, missing } = followTransfers(blocks, [wallet], [])
    expect([...reached]).toEqual([change])
    expect(missing).toEqual([
      [6, 8],
      [10, 10],
    ])
    expect(describeRanges(missing)).toBe('blocks 6..8, 10')
    expect(describeRanges([[4, 4]])).toBe('block 4')
  })

  it('ignores zero-value calls and contract creations', () => {
    const blocks: ReachBlock[] = [
      { number: 1, block: { transactions: [tx(wallet, unknown, '0x0'), { from: wallet, to: null, value: '0x5' }] } },
    ]
    expect([...followTransfers(blocks, [wallet], []).reached]).toEqual([])
  })
})
