/** @jest-environment jsdom */

import { flushPromises, mount } from '@vue/test-utils'
import * as quasar from 'quasar'
import { defineComponent, h, reactive } from 'vue'

import {
  buildRaffleDrawItem,
  sha256Hex,
} from '@frank/wallet/message-item-plugins/raffle/draw'
import enUS from '../../../i18n/en-us'
import frFR from '../../../i18n/fr-fr'
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

function t(
  messages: unknown,
  key: string,
  params: Record<string, string> = {},
) {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages)
  return typeof value === 'string'
    ? value.replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`)
    : key
}
const $t = (k: string, p?: Record<string, string>) => t(enUS, k, p)
const VERIFIED = enUS.raffleDraw.verified

let ts = 0
const from = (item: any, sender = BOT, outbound = false) => ({
  outbound,
  status: 'ok',
  receivedTime: ++ts,
  serverTime: ts,
  outpoints: [],
  senderAddress: sender,
  items: [item],
})
const fromBot = (item: any) => from(item)

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

/** Mounts the component for `messages[index]`'s first item (default: the last message). */
async function mountAt(
  messages: any[],
  index = messages.length - 1,
  item?: any,
) {
  store.chats = { [BOT]: { messages } }
  const w = mount(ChatMessageRaffle, {
    props: {
      address: BOT,
      item: item ?? store.chats[BOT].messages[index].items[0],
    },
    global: { stubs: quasarStubs, mocks: { $t } },
  })
  await flushPromises()
  return w
}
const renderDraw = (thread: any[], draw: any) =>
  mountAt([...thread, fromBot(draw)])

describe('ChatMessageRaffle draw verification', () => {
  it('shows the commitment-match badge for a round the bot announced and then drew', async () => {
    const w = await renderDraw(
      [fromBot(announce()), fromBot(joined())],
      botDraw(),
    )
    expect(w.text()).toContain(VERIFIED)
    expect(w.text()).not.toContain('Verification failed')
    expect(w.text()).not.toContain('Verified fair')
  })

  it('the badge is a status region with an expandable explainer of what is and is not shown', async () => {
    const w = await renderDraw([fromBot(announce())], botDraw())
    const status = w.find('[role="status"]')
    expect(status.exists()).toBe(true)
    expect(status.text()).toContain(VERIFIED)
    const details = status.find('details')
    expect(details.find('summary').text()).toBe(enUS.raffleDraw.explainerToggle)
    expect(details.text()).toContain('real on-chain payments')
    expect(details.text()).toContain('no entries were left out')
  })

  it('en-us and fr-fr both carry the new wording (no overclaim in either)', () => {
    for (const messages of [enUS, frFR] as any[]) {
      expect(messages.raffleDraw.verified.length).toBeGreaterThan(0)
      expect(messages.raffleDraw.verified.toLowerCase()).not.toMatch(
        /fair|équitable/,
      )
    }
  })

  it('accepts a draw without its own hash (what bots sent before #318)', async () => {
    const { serverSeedHash: _omitted, ...legacyDraw } = botDraw()
    const w = await renderDraw([fromBot(announce())], legacyDraw)
    expect(w.text()).toContain(VERIFIED)
  })

  it('a joined reply alone is not a pre-entry commitment: no claim', async () => {
    const w = await renderDraw([fromBot(joined())], botDraw())
    expect(w.text()).not.toContain(VERIFIED)
    expect(w.text()).not.toContain('Verification failed')
  })

  it('shows the failure text when the revealed seed does not open the commitment', async () => {
    const w = await renderDraw([fromBot(announce())], {
      ...botDraw(),
      serverSeed: 'a-seed-picked-after-the-entries',
    })
    expect(w.text()).toContain('Verification failed')
    expect(w.text()).not.toContain(VERIFIED)
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

  it('rejects a draw with a repeated entrant or payment, or a wrong number of entrants', async () => {
    const dup = await renderDraw([fromBot(announce())], {
      ...botDraw(),
      entrants: ['0xa1', '0xa1', '0xc3', '0xd4', '0xe5'],
    })
    expect(dup.text()).toContain('same entrant more than once')
    const short = await renderDraw([fromBot(announce())], {
      ...botDraw(),
      entrants: ENTRANTS.slice(0, 4),
      entryTxHashes: TXS.slice(0, 4),
    })
    expect(short.text()).toContain('announced 5')
  })

  it('does not trust a hash that only arrives with the draw', async () => {
    const w = await renderDraw([], botDraw())
    expect(w.text()).not.toContain(VERIFIED)
    expect(w.text()).not.toContain('Verification failed')
  })

  it('ignores a commitment that arrives after the draw', async () => {
    const w = await mountAt([fromBot(botDraw()), fromBot(announce())], 0)
    expect(w.text()).not.toContain(VERIFIED)
  })

  it('a draw item that is not found in the chat (a clone) makes no claim, even with a later announce', async () => {
    const messages = [fromBot(botDraw()), fromBot(announce())]
    const clone = JSON.parse(JSON.stringify(messages[0].items[0]))
    const w = await mountAt(messages, 0, clone)
    expect(w.text()).not.toContain(VERIFIED)
    expect(w.text()).not.toContain('Verification failed')
  })

  it('does not accept a commitment from a different sender than the draw', async () => {
    const w = await mountAt([from(announce(), '0xMallory'), fromBot(botDraw())])
    expect(w.text()).not.toContain(VERIFIED)
    const w2 = await mountAt([
      fromBot(announce()),
      from(botDraw(), '0xMallory'),
    ])
    expect(w2.text()).not.toContain(VERIFIED)
  })

  it('compares the sender case-insensitively (EIP-55 vs lowercase)', async () => {
    const w = await mountAt([
      from(announce(), BOT.toLowerCase()),
      fromBot(botDraw()),
    ])
    expect(w.text()).toContain(VERIFIED)
  })

  it('does not accept an outbound (our own) message as the commitment', async () => {
    const w = await mountAt([from(announce(), BOT, true), fromBot(botDraw())])
    expect(w.text()).not.toContain(VERIFIED)
  })

  it('makes no claim for an outbound draw', async () => {
    const w = await mountAt([fromBot(announce()), from(botDraw(), BOT, true)])
    expect(w.text()).not.toContain(VERIFIED)
  })

  it('known answer: the five-entrant vector draws 0xb2 and shows the badge', async () => {
    const draw = botDraw()
    expect(draw.winnerAddress).toBe('0xb2')
    const w = await renderDraw([fromBot(announce())], draw)
    expect(w.text()).toContain('0xb2')
    expect(w.text()).toContain(VERIFIED)
    // Moving the winner one place (a shifted derivation) must fail verification.
    const shifted = await renderDraw([fromBot(announce())], {
      ...draw,
      winnerAddress: '0xc3',
    })
    expect(shifted.text()).toContain('Verification failed')
  })

  it.each([
    ['numeric entrants', { entrants: [1, 2, 3] }],
    ['string entrants', { entrants: 'abc' }],
    ['numeric tx hashes', { entryTxHashes: [1, 2, 3, 4, 5] }],
  ])(
    'renders (no throw) a failure state for malformed peer data: %s',
    async (_n, over) => {
      const w = await renderDraw([fromBot(announce())], {
        ...botDraw(),
        ...over,
      })
      expect(w.text()).toContain('Verification failed')
      expect(w.text()).not.toContain(VERIFIED)
    },
  )

  it('a junk potWei renders as ? instead of throwing', async () => {
    const w = await renderDraw([fromBot(announce())], {
      ...botDraw(),
      potWei: 'junk',
    })
    expect(w.text()).toContain('Pot: ?')
  })

  it('says the entrant count is unchecked when the announce carried no round size', async () => {
    const { maxEntries: _m, ...noSize } = announce()
    const w = await renderDraw([fromBot(noSize)], botDraw())
    expect(w.text()).toContain(VERIFIED)
    expect(w.text()).toContain(enUS.raffleDraw.explainerCountUnverified)
    const sized = await renderDraw([fromBot(announce())], botDraw())
    expect(sized.text()).not.toContain(enUS.raffleDraw.explainerCountUnverified)
  })
})
