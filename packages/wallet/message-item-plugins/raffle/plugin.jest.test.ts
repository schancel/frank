import { describePluginContract } from '../shared/plugin-contract.testutil'
import { initRafflePlugin } from './plugin'

import { registryWith } from '../shared/plugin-contract.testutil'

describePluginContract({
  type: 'raffle',
  init: initRafflePlugin,
  samples: [
    {
      item: {
        type: 'raffle',
        raffleId: 'r1',
        action: 'announce',
        entryPriceWei: '10',
        maxEntries: 3,
        entryCount: 1,
        serverSeedHash:
          'abababababababababababababababababababababababababababababababab',
      },
      preview: 'Raffle open (1/3 entered)',
    },
    {
      item: { type: 'raffle', raffleId: 'r1', action: 'announce' },
      preview: 'Raffle open (0/? entered)',
    },
    {
      item: { type: 'raffle', raffleId: 'r1', action: 'enter' },
      preview: 'Entered the raffle',
    },
    {
      item: {
        type: 'raffle',
        raffleId: 'r1',
        action: 'joined',
        maxEntries: 3,
        entryCount: 2,
      },
      preview: 'Joined the raffle (2/3)',
    },
    {
      item: {
        type: 'raffle',
        raffleId: 'r1',
        action: 'draw',
        winnerAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        serverSeed:
          '5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e',
        entrants: [
          '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        ],
        entryTxHashes: [
          '0x0101010101010101010101010101010101010101010101010101010101010101',
          '0x0202020202020202020202020202020202020202020202020202020202020202',
        ],
        potWei: '20',
      },
      preview: 'Raffle drawn',
    },
    {
      item: { type: 'raffle', raffleId: 'r1', action: 'error' },
      preview: 'Raffle error',
    },
    {
      item: {
        type: 'raffle',
        raffleId: 'r1',
        action: 'error',
        message: 'already entered',
      },
      preview: 'already entered',
    },
  ],
})

it('hydrate still takes the paid amount from the message stamp only', async () => {
  const registry = registryWith('raffle', initRafflePlugin)
  const enter = {
    type: 'raffle' as const,
    raffleId: 'r1',
    action: 'enter' as const,
  }
  const [entry] = await registry.hydrateItems(
    { items: [enter], stampValueWei: 7n } as never,
    {} as never,
  )
  expect(entry).toMatchObject({ kind: 'hydrated', hydrated: { paidWei: 7n } })
})
