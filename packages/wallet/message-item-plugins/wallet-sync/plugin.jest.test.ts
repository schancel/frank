import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initWalletSyncPlugin } from './plugin'

import { registryWith } from '../shared/plugin-contract.testutil'

const incoming = {
  type: 'wallet-sync' as const,
  direction: 'in' as const,
  chainIdentifier: 'monad-testnet',
  txHash: '0x1234567890abcdef',
  rawTx: '0x02abcd',
  spentInputs: [
    { address: '0xA', nonce: 3, valueWei: '150' },
    { address: 'ecash:q', outpoint: 'aa:0' },
  ],
  createdOutputs: [
    { address: '0xB', valueWei: '100', branch: 'spend' as const, index: 4 },
    {
      address: '0xC',
      valueWei: '25',
      branch: 'change' as const,
      outpoint: 'bb:1',
    },
    { address: '0xD' },
  ],
  transfer: {
    networkTag: 'MONT',
    txId: '0x1234567890abcdef',
    vout: 0,
    destination: '0xB',
    value: '100',
    token: 'USDC',
    rawTx: '0x02abcd',
  },
  memo: 'thanks',
  timestamp: 1728000000000,
}
const outgoing = {
  type: 'wallet-sync' as const,
  direction: 'out' as const,
  chainIdentifier: 'monad-testnet',
  txHash: '0xfedcba0987654321',
  createdOutputs: [{ address: '0xB', valueWei: '100' }],
}

describePluginContract({
  type: 'wallet-sync',
  init: initWalletSyncPlugin,
  samples: [
    {
      item: incoming,
      preview: 'Wallet sync: Received tx 0x12345678... on monad-testnet',
    },
    {
      item: outgoing,
      preview: 'Wallet sync: Sent tx 0xfedcba09... on monad-testnet',
    },
  ],
})

it('tallies the created outputs of an incoming item only', () => {
  const registry = registryWith('wallet-sync', initWalletSyncPlugin)
  expect(registry.tallyValue([incoming])).toBe(125)
  expect(registry.tallyValue([outgoing])).toBe(0)
  expect(registry.tallyValue([incoming, outgoing, incoming])).toBe(250)
})

it('previews a legacy item that names its chain only in chainId', () => {
  const registry = registryWith('wallet-sync', initWalletSyncPlugin)
  const legacy = { ...outgoing, chainIdentifier: undefined, chainId: 'monad' }
  expect(registry.previewText(legacy as never)).toBe(
    'Wallet sync: Sent tx 0xfedcba09... on monad',
  )
})
