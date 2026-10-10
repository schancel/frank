/**
 * Every carried message item type crosses the real canonical path between two real wallets:
 * `directMessages.send` at A (funding, intent, sealing, relay submission) and `fetchSince` at B
 * (mailbox read, authentication, opening). The item arrives with the same type and fields. The
 * five types with a dedicated frame are sealed with exactly the bytes their encoders always wrote.
 */
import * as canonicalDm from '@frank/cashweb/relay/canonical-dm'
import type { MessageItem } from '@frank/cashweb/types/messages'
import {
  encodeBlackjackHandV3Item,
  encodeChannelUpdateItem,
  encodeEmailMessageItem,
  encodePluginMessageItem,
  encodeStealthMessageItem,
  toHex,
} from '@frank/codec'

import { createDefaultMessageItemRegistry } from '../message-item-plugins/default-registry'
import {
  MessageItemEncodeError,
  MessageItemUnsupportedError,
  createMessageItemRegistry,
  pluginCapabilitiesNotYetAvailable,
} from '../message-item-plugins/registry'
import * as wire from '../message-item-plugins/wire'
import {
  DEDICATED_SAMPLES,
  GENERIC_SAMPLES,
  NOT_CARRIED_PROPOSAL_SAMPLES,
} from '../message-item-plugins/wire-samples.testutil'
import { isDirectMessageNotAttempted } from './active-chain'
import {
  STAMP,
  providerBroadcasts,
  table,
  type Seat,
} from './canonical-two-wallets.testutil'
import {
  CanonicalMessageItemsNotInstalledError,
  installMessageItemRegistry,
} from './monad-canonical-dm'

jest.mock('../monad-provider', () =>
  require('./canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../monad-http', () =>
  require('./canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('./canonical-two-wallets.testutil').offlineMailboxModule(),
)

describe('message items across the canonical path, two wallets', () => {
  jest.setTimeout(120_000)
  let f: Awaited<ReturnType<typeof table>>['f']
  let alice: Seat
  let bob: Seat
  let sealed: jest.SpyInstance
  // The composition both wallets normally run with.
  const registry = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  let removeAlice: () => void

  beforeAll(async () => {
    ;({ f, alice, bob } = await table())
    removeAlice = installMessageItemRegistry(alice.wallet, registry)
    installMessageItemRegistry(bob.wallet, registry)
    sealed = jest.spyOn(canonicalDm, 'prepareDirectMessage')
  })
  afterAll(async () => {
    sealed.mockRestore()
    await f.close()
  })

  /** Sends from Alice, reads at Bob, and returns what Bob got and the frames that were sealed. */
  async function roundTrip(items: MessageItem[]) {
    sealed.mockClear()
    f.setMailbox(bob.mailbox)
    const sent = await f.chain.directMessages.send({
      wallet: alice.wallet,
      recipient: bob.wallet.identity.address,
      items,
      stampValue: STAMP,
    })
    f.setMailbox(undefined)
    const received = await f.chain.directMessages.fetchSince({
      wallet: bob.wallet,
      sinceMs: bob.since,
    })
    const message = received.find(m => m.payloadDigest === sent.payloadDigest)
    if (!message) throw new Error('the message did not arrive')
    bob.since = Math.max(bob.since, message.receivedTime)
    expect(sealed).toHaveBeenCalledTimes(1)
    const frames = (sealed.mock.calls[0][0] as { items: Uint8Array[] }).items
    return { message, frames }
  }

  const dedicatedBytes = (item: MessageItem): Uint8Array => {
    switch (item.type) {
      case 'text':
        return canonicalDm.directMessageText(item.text)
      case 'blackjack-hand':
        return encodeBlackjackHandV3Item(item)
      case 'stealth':
        return encodeStealthMessageItem(item as never)
      case 'channel-update':
        return encodeChannelUpdateItem(item)
      case 'email':
        return encodeEmailMessageItem(item)
      default:
        throw new Error(`${item.type} has no dedicated frame`)
    }
  }

  it.each(DEDICATED_SAMPLES.map(item => [item.type, item] as const))(
    '%s: arrives intact, sealed with the same bytes as before',
    async (type, item) => {
      const { message, frames } = await roundTrip([item])
      expect(frames.map(toHex)).toEqual([toHex(dedicatedBytes(item))])
      expect(message.outbound).toBe(false)
      expect(message.items).toHaveLength(1)
      expect(message.items[0].type).toBe(type)
      expect(message.items[0]).toMatchObject(item)
      expect(message.stampValueWei).toBe(STAMP)
    },
  )

  it.each(GENERIC_SAMPLES.map(item => [item.type, item] as const))(
    '%s: arrives as the same item, carried in the generic plugin frame',
    async (type, item) => {
      const { message, frames } = await roundTrip([item])
      expect(frames).toHaveLength(1)
      // "FRNK", then an envelope whose type identifier is 27.
      expect(toHex(frames[0])).toBe(
        toHex(
          encodePluginMessageItem({
            itemType: type,
            data: registry.encodeItem(item).bytes,
          }),
        ),
      )
      expect(message.items).toEqual([item])
      expect(message.stampValueWei).toBe(STAMP)
    },
  )

  it('a bot reply of several items (a purchase: fulfilment, picture, text) arrives whole and in order', async () => {
    const items: MessageItem[] = [
      { type: 'digital-goods', action: 'fulfill', itemId: 'sticker_1' },
      { type: 'image', image: 'data:image/png;base64,AAAA' },
      { type: 'text', text: 'Thanks for your purchase!' },
    ]
    const { message } = await roundTrip(items)
    expect(message.items).toEqual(items)
  })

  // The app holds a picture to 448 KiB of data URI and its caption to 2,000 characters
  // (app/src/utils/image-data-uri.ts) so the two, with a reply reference, always fit one sealed
  // message. Above about 523,000 bytes the message is refused only at sealing, after funding.
  it('the largest picture the app sends, with the longest caption and a reply, arrives whole', async () => {
    const items: MessageItem[] = [
      { type: 'reply', payloadDigest: 'ab'.repeat(32) },
      { type: 'image', image: 'A'.repeat(448 * 1024) },
      { type: 'text', text: '\u{1F600}'.repeat(2000) },
    ]
    const { message } = await roundTrip(items)
    expect(message.items).toEqual(items)
  })

  describe('refusals happen before anything is paid', () => {
    async function refused(items: MessageItem[]) {
      const requests = f.requests.length
      const broadcasts = providerBroadcasts.length
      sealed.mockClear()
      f.setMailbox(bob.mailbox)
      const error = await f.chain.directMessages
        .send({
          wallet: alice.wallet,
          recipient: bob.wallet.identity.address,
          items,
          stampValue: STAMP,
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      f.setMailbox(undefined)
      // Nothing was sealed, nothing reached the relay and nothing was broadcast to fund it.
      expect(sealed).not.toHaveBeenCalled()
      expect(f.requests.length).toBe(requests)
      expect(providerBroadcasts.length).toBe(broadcasts)
      expect(isDirectMessageNotAttempted(error)).toBe(true)
      return error
    }

    it('an item of a type with no plugin', async () => {
      expect(await refused([{ type: 'hologram' } as never])).toBeInstanceOf(
        MessageItemUnsupportedError,
      )
    })

    it('a registered type this path does not carry', async () => {
      expect(
        await refused([
          {
            type: 'wallet-sync',
            direction: 'out',
            chainIdentifier: 'monad-testnet',
            txHash: '0x' + 'ab'.repeat(32),
          },
        ]),
      ).toBeInstanceOf(MessageItemUnsupportedError)
    })

    it('an item its plugin refuses to encode', async () => {
      expect(
        await refused([{ type: 'dice', action: 'cheat' } as never]),
      ).toBeInstanceOf(MessageItemEncodeError)
    })

    it('text too long for a text frame (refused at sealing, after funding, before this change)', async () => {
      expect(
        await refused([{ type: 'text', text: 'x'.repeat(262_145) }]),
      ).toBeInstanceOf(MessageItemEncodeError)
    })

    it('an empty message', async () => {
      expect(await refused([])).toBeInstanceOf(Error)
    })

    it('a wallet with no registry installed sends nothing and reads nothing', async () => {
      removeAlice()
      try {
        expect(await refused([{ type: 'text', text: 'hi' }])).toBeInstanceOf(
          CanonicalMessageItemsNotInstalledError,
        )
        await expect(
          f.chain.directMessages.fetchSince({
            wallet: alice.wallet,
            sinceMs: 0,
          }),
        ).rejects.toBeInstanceOf(CanonicalMessageItemsNotInstalledError)
      } finally {
        removeAlice = installMessageItemRegistry(alice.wallet, registry)
      }
    })
  })

  describe.each(
    NOT_CARRIED_PROPOSAL_SAMPLES.map(item => [item.type, item] as const),
  )('%s is not carried', (type, item) => {
    it('is refused on send before anything is paid', async () => {
      const requests = f.requests.length
      const broadcasts = providerBroadcasts.length
      sealed.mockClear()
      f.setMailbox(bob.mailbox)
      const error = await f.chain.directMessages
        .send({
          wallet: alice.wallet,
          recipient: bob.wallet.identity.address,
          items: [item],
          stampValue: STAMP,
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        )
      f.setMailbox(undefined)
      expect(error).toBeInstanceOf(wire.MessageItemNotCarriedError)
      expect((error as Error).message).toBe(
        `Canonical direct messages cannot carry '${type}' items yet; nothing was paid or sent.`,
      )
      expect(isDirectMessageNotAttempted(error)).toBe(true)
      expect(sealed).not.toHaveBeenCalled()
      expect(f.requests.length).toBe(requests)
      expect(providerBroadcasts.length).toBe(broadcasts)
    })

    it('one a peer delivers anyway, in well-formed bytes, arrives as unsupported and adds no value', async () => {
      // A peer running other code: its sender writes the frame this wallet's sender refuses.
      const forged = encodePluginMessageItem({
        itemType: type,
        data: registry.encodeItem(item).bytes,
      })
      const peer = jest
        .spyOn(wire, 'encodeItemFrames')
        .mockReturnValueOnce([
          forged,
          canonicalDm.directMessageText('look at this'),
        ])
      try {
        const { message, frames } = await roundTrip([
          { type: 'text', text: 'placeholder' },
        ])
        expect(frames.map(toHex)).toEqual([
          toHex(forged),
          toHex(canonicalDm.directMessageText('look at this')),
        ])
        expect(message.items).toEqual([
          {
            type: 'unsupported',
            reason: 'unknown-type',
            itemType: type,
            frameType: 27,
            frame: toHex(forged),
          },
          { type: 'text', text: 'look at this' },
        ])
        // No field of the item survives for a renderer or a bot to act on.
        expect(Object.keys(message.items[0]).sort()).toEqual([
          'frame',
          'frameType',
          'itemType',
          'reason',
          'type',
        ])
        expect(registry.tallyValue(message.items)).toBe(0)
      } finally {
        peer.mockRestore()
      }
    })
  })

  describe('an item the reader cannot interpret', () => {
    it('is kept as unsupported beside the readable items, and fetchSince does not throw', async () => {
      // Alice has a plugin Bob does not: a newer app talking to an older one.
      const newer = createMessageItemRegistry()
      for (const type of registry.types()) newer.register(registry.get(type)!)
      newer.register({
        type: 'hologram' as never,
        hydrate: raw => raw,
        previewText: () => 'A hologram',
        encode: () => Uint8Array.of(0xca, 0xfe),
        decode: () => ({ type: 'hologram' } as never),
      })
      installMessageItemRegistry(alice.wallet, newer)
      try {
        const { message, frames } = await roundTrip([
          { type: 'text', text: 'before' },
          { type: 'hologram' } as never,
          { type: 'text', text: 'after' },
        ])
        expect(message.items).toEqual([
          { type: 'text', text: 'before' },
          {
            type: 'unsupported',
            reason: 'unknown-type',
            itemType: 'hologram',
            frameType: 27,
            frame: toHex(frames[1]),
          },
          { type: 'text', text: 'after' },
        ])
        // The message's payment is still accounted for.
        expect(message.stampValueWei).toBe(STAMP)
      } finally {
        removeAlice = installMessageItemRegistry(alice.wallet, registry)
      }
    })

    it('a known type with bytes its plugin refuses is kept as malformed, and the rest is delivered', async () => {
      // Alice's dice plugin writes bytes Bob's real dice plugin does not accept.
      const broken = createMessageItemRegistry()
      for (const type of registry.types())
        if (type !== 'dice') broken.register(registry.get(type)!)
      broken.register({
        type: 'dice',
        hydrate: raw => raw,
        previewText: () => '',
        encode: () => Uint8Array.of(0xff, 0x00, 0x13, 0x37),
        decode: () => ({ type: 'dice', action: 'roll' }),
      })
      installMessageItemRegistry(alice.wallet, broken)
      try {
        const { message, frames } = await roundTrip([
          { type: 'dice', action: 'roll' },
          { type: 'text', text: 'still delivered' },
        ])
        expect(message.items).toEqual([
          {
            type: 'unsupported',
            reason: 'malformed',
            itemType: 'dice',
            frameType: 27,
            frame: toHex(frames[0]),
          },
          { type: 'text', text: 'still delivered' },
        ])
        // A later good message from the same peer is read normally: the inbox is not blocked.
        removeAlice = installMessageItemRegistry(alice.wallet, registry)
        const next = await roundTrip([{ type: 'text', text: 'next' }])
        expect(next.message.items).toEqual([{ type: 'text', text: 'next' }])
      } finally {
        removeAlice = installMessageItemRegistry(alice.wallet, registry)
      }
    })
  })
})
