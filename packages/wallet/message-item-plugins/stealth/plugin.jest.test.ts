import { encodeStealthMessageItem } from '@frank/codec'
import type { StealthItem } from '@frank/cashweb/types/messages'

import {
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initStealthPlugin } from './plugin'

const pub = '02' + '11'.repeat(32)
const tx1 = 'aabbccddeeff00112233445566778899'
const tx2 = '11223344556677889900aabbccddeeff'

const canonical: StealthItem = {
  type: 'stealth',
  networkTag: 'MONT',
  keyType: 1,
  ephemeralPubKey: pub,
  transactions: [tx1, tx2],
  amount: 1000000,
  memo: 'Coffee payment',
}
const legacy: StealthItem = {
  type: 'stealth',
  chainId: 'MONT',
  ephemeralPubKey: pub,
  rawTx: tx1,
  amount: 42,
}

describePluginContract({
  type: 'stealth',
  init: initStealthPlugin,
  samples: [
    {
      item: canonical,
      preview: 'Sent stealth payment (MONT)',
      // A decoded item also carries the frame's exact integer amount.
      decoded: { ...canonical, amountWei: '1000000' },
    },
    {
      item: legacy,
      preview: 'Sent stealth payment (MONT)',
      // The deprecated fields are folded into the canonical ones on the wire, as today.
      decoded: {
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: pub,
        transactions: [tx1],
        amount: 42,
        amountWei: '42',
      },
    },
  ],
})

describe('stealth wire bytes and value', () => {
  const registry = registryWith('stealth', initStealthPlugin)

  it('are the bytes the canonical path writes today', () => {
    expect(registry.encodeItem(canonical).bytes).toEqual(
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: pub,
        transactions: [tx1, tx2],
        amount: 1000000,
        memo: 'Coffee payment',
      }),
    )
    expect(registry.encodeItem(legacy).bytes).toEqual(
      encodeStealthMessageItem({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: pub,
        transactions: [tx1],
        amount: 42,
        memo: undefined,
      }),
    )
  })

  it('refuses the same incomplete items with the same messages as today', () => {
    const encode = (item: Partial<StealthItem>) => () =>
      registry.encodeItem({
        type: 'stealth',
        amount: 1,
        ...item,
      } as StealthItem)
    expect(encode({})).toThrow('Stealth item must have networkTag or chainId')
    expect(encode({ networkTag: 'MONT' })).toThrow(
      'Stealth item must have ephemeralPubKey',
    )
    expect(encode({ networkTag: 'MONT', ephemeralPubKey: pub })).toThrow(
      'Stealth item must have at least one transaction',
    )
  })

  it('previews without a network and tallies the self-reported amount', () => {
    expect(registry.previewText({ type: 'stealth', amount: 3 })).toBe(
      'Sent stealth payment',
    )
    expect(registry.tallyValue([canonical, legacy])).toBe(1000042)
  })
})
