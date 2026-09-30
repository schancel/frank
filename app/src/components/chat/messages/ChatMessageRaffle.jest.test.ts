/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import {
  buildRaffleDrawItem,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/raffle/draw'
import ChatMessageRaffle from './ChatMessageRaffle.vue'

const BOT = '0xRaffleBot'
const store: { chats: Record<string, { messages: any[] }> } = reactive({
  chats: {},
}) as any

jest.mock('../../../stores/chats', () => ({ useChatStore: () => store }))
jest.mock('../../../composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(async () => ({
    identity: { displayAddress: '0xa1' },
  })),
}))
jest.mock('../../../utils/notifications', () => ({ errorNotify: jest.fn() }))
jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    unit: 'MON',
    toDisplayAmount: (n: bigint) => (Number(n) / 1e18).toString(),
  },
}))

function passthrough(tag: string) {
  return defineComponent({
    props: { modelValue: null, label: null },
    setup(props, { slots }) {
      return () =>
        h(tag, {}, [props.label as string | undefined, slots.default?.()])
    },
  })
}
const quasarStubs: Record<string, any> = Object.fromEntries(
  Object.keys(quasar)
    .filter(n => /^Q[A-Z]/.test(n))
    .map(n => [n, passthrough('div')]),
)

let ts = 0
const fromBot = (item: any) => ({
  outbound: false,
  status: 'ok',
  receivedTime: ++ts,
  serverTime: ts,
  outpoints: [],
  senderAddress: BOT,
  items: [item],
})

const SEED = 'seed-committed-before-any-entry'
const ENTRANTS = ['0xa1', '0xb2', '0xc3', '0xd4', '0xe5']
const TXS = ENTRANTS.map((_, i) => `0xtx${i}`)
const announce = () => ({
  type: 'raffle',
  raffleId: 'r1',
  action: 'announce',
  entryPriceWei: '20000000000000000',
  maxEntries: 5,
  entryCount: 0,
  serverSeedHash: sha256Hex(SEED),
})
const joined = () => ({ ...announce(), action: 'joined', entryCount: 1 })
// Exactly what the bot sends: raffle-bot.livecheck.ts builds it with buildRaffleDrawItem.
const botDraw = () =>
  buildRaffleDrawItem({
    raffleId: 'r1',
    entryPriceWei: '20000000000000000',
    serverSeed: SEED,
    entrants: ENTRANTS,
    entryTxHashes: TXS,
  })

async function renderDraw(thread: any[], draw: any) {
  store.chats = { [BOT]: { messages: [...thread, fromBot(draw)] } }
  const item = store.chats[BOT].messages.at(-1).items[0]
  const w = mount(ChatMessageRaffle, {
    props: { address: BOT, item },
    global: { stubs: quasarStubs },
  })
  await flushPromises()
  return w
}

describe('ChatMessageRaffle draw verification', () => {
  it('shows "Verified fair" for a round the bot announced and then drew', async () => {
    const w = await renderDraw([fromBot(announce()), fromBot(joined())], botDraw())
    expect(w.text()).toContain('Verified fair')
    expect(w.text()).not.toContain('Verification failed')
  })

  it('shows "Verified fair" for a draw without its own hash (what bots sent before #318)', async () => {
    const { serverSeedHash: _omitted, ...legacyDraw } = botDraw()
    const w = await renderDraw([fromBot(announce())], legacyDraw)
    expect(w.text()).toContain('Verified fair')
  })

  it('shows "Verified fair" when only the joined reply carries the commitment', async () => {
    const w = await renderDraw([fromBot(joined())], botDraw())
    expect(w.text()).toContain('Verified fair')
  })

  it('shows the failure text when the revealed seed does not open the commitment', async () => {
    const w = await renderDraw([fromBot(announce())], {
      ...botDraw(),
      serverSeed: 'a-seed-picked-after-the-entries',
    })
    expect(w.text()).toContain('Verification failed')
    expect(w.text()).not.toContain('Verified fair')
  })

  it('shows the failure text when the announced winner is not the computed one', async () => {
    const real = botDraw()
    const other = ENTRANTS.find(e => e !== real.winnerAddress)
    const w = await renderDraw([fromBot(announce())], {
      ...real,
      winnerAddress: other,
    })
    expect(w.text()).toContain('Verification failed')
  })

  it('does not trust a hash that only arrives with the draw', async () => {
    const w = await renderDraw([], botDraw())
    expect(w.text()).not.toContain('Verified fair')
    expect(w.text()).not.toContain('Verification failed')
  })

  it('ignores a commitment that arrives after the draw', async () => {
    store.chats = {
      [BOT]: { messages: [fromBot(botDraw()), fromBot(announce())] },
    }
    const item = store.chats[BOT].messages[0].items[0]
    const w = mount(ChatMessageRaffle, {
      props: { address: BOT, item },
      global: { stubs: quasarStubs },
    })
    await flushPromises()
    expect(w.text()).not.toContain('Verified fair')
  })
})
