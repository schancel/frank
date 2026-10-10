import { secp256k1 } from '@noble/curves/secp256k1'

import { encodeChannelUpdateItem, fromHex, toHex } from '@frank/codec'
import type { ChannelUpdateItem } from '@frank/cashweb/types/messages'

import {
  describePluginContract,
  registryWith,
} from '../shared/plugin-contract.testutil'
import { initChannelUpdatePlugin } from './plugin'

const alice = toHex(secp256k1.getPublicKey(fromHex('01'.repeat(32)), true))
const bob = toHex(secp256k1.getPublicKey(fromHex('02'.repeat(32)), true))

const item: ChannelUpdateItem = {
  type: 'channel-update',
  channelId: '44'.repeat(32),
  appId: 'dice',
  sequenceNumber: 7,
  allocations: [
    {
      networkTag: 'mont',
      token: '',
      balances: [
        { participant: { keyType: 1, pubKey: alice }, balance: '1000' },
        { participant: { keyType: 1, pubKey: bob }, balance: '2000' },
      ],
    },
  ],
  appState: new Uint8Array([1, 2]),
  signatures: [
    {
      algorithm: 1,
      signer: { keyType: 1, pubKey: alice },
      signature: toHex(new Uint8Array(64).fill(0x11)),
    },
  ],
}

describePluginContract({
  type: 'channel-update',
  init: initChannelUpdatePlugin,
  samples: [{ item, preview: 'State channel update: dice (seq 7)' }],
})

describe('channel-update wire bytes', () => {
  it('are the bytes the canonical path writes today', () => {
    const registry = registryWith('channel-update', initChannelUpdatePlugin)
    expect(registry.encodeItem(item).bytes).toEqual(
      encodeChannelUpdateItem(item),
    )
  })
})
