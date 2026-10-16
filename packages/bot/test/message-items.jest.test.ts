import type { Provider } from 'ethers'
import {
  encodeCanonical,
  encodeFrame,
  encodePluginMessageItem,
  MAX_CONTAINERS,
  standaloneItemBudget,
  validateFrame,
  type Encodable,
} from '@frank/codec'
import {
  decodeItemFrames,
  MessageItemBudgetExceededError,
} from '../../wallet/message-item-plugins/wire'
import { createBotMessageItemRegistry } from '../src/message-items'
import { createAppMessageItemRegistry } from '../../../app/src/utils/message-items'
import { createDefaultMessageItemRegistry } from '../../wallet/message-item-plugins/default-registry'
import { pluginCapabilitiesNotYetAvailable } from '../../wallet/message-item-plugins/registry'
import { installMessageItemRegistry } from '../../wallet/chain/evm-canonical-dm'
import {
  STAMP,
  table,
  type Seat,
} from '../../wallet/chain/canonical-two-wallets.testutil'
import {
  encodeSignedSwapEvent,
  type SwapResult,
} from '../../swap-protocol/src/index'
import {
  buildNegotiationOffer,
  buildNegotiationResponse,
  TESTNET_NEGOTIATION_POLICY,
} from '../../swap-protocol/src/negotiation'
import type { ApplicationMessageItem } from '@frank/cashweb/types/messages'

jest.mock('../../wallet/evm-provider', () =>
  require('../../wallet/chain/canonical-two-wallets.testutil').offlineProviderModule(),
)
jest.mock('../../wallet/evm-http', () =>
  require('../../wallet/chain/canonical-two-wallets.testutil').offlineHttpModule(),
)
jest.mock('@frank/cashweb/relay/monad-mailbox-client', () =>
  require('../../wallet/chain/canonical-two-wallets.testutil').offlineMailboxModule(),
)
function encodeItemFramesUnsupported(
  item: import('@frank/cashweb/types/messages').MessageItem,
): string {
  if (item.type !== 'unsupported') throw Error('Expected unsupported')
  return item.frame
}
function must<T>(v: SwapResult<T>): T {
  if (!v.ok) throw Error(v.error.code)
  return v.value
}

it('actual app and all-bots registries carry signed offer/accept/reject bidirectionally, including orphan responses', async () => {
  const { f, alice, bob } = await table()
  const app = createAppMessageItemRegistry(),
    bot = createBotMessageItemRegistry()
  installMessageItemRegistry(alice.wallet, app)
  installMessageItemRegistry(bob.wallet, bot)
  const conversationId = new Uint8Array(16).fill(0x39)
  const context = {
    swapId: new Uint8Array(32).fill(0x45),
    conversationId,
    parties: [
      alice.wallet.identity.compressedPubKey,
      bob.wallet.identity.compressedPubKey,
    ] as const,
    policy: TESTNET_NEGOTIATION_POLICY,
  }
  const signA = async (d: Uint8Array) =>
    alice.wallet.identity.signHash(Buffer.from(d))
  const signB = async (d: Uint8Array) =>
    bob.wallet.identity.signHash(Buffer.from(d))
  try {
    const offer = must(
      encodeSignedSwapEvent(
        must(
          await buildNegotiationOffer(
            context,
            {
              xecPrincipal: 100n,
              evmPrincipal: 1000000000000000000n,
              expiry: 2000000000n,
            },
            signA,
          ),
        ),
      ),
    )
    function children(frames: Uint8Array[]) {
      const parsed = validateFrame(
        encodeFrame(
          { typeId: 20, schemaVersion: 1, minReaderVersion: 1 },
          new Map<number, Encodable>([
            [0, 'frank'],
            [1, frames],
          ]),
        ),
      )
      if (parsed.kind !== 'parsed' || parsed.typed?.type !== 20)
        throw Error('Invalid test revision')
      return parsed.typed.items
    }
    const known = encodePluginMessageItem({
      itemType: 'swap-negotiation-v1',
      data: offer,
    })
    const absent = createDefaultMessageItemRegistry(
      pluginCapabilitiesNotYetAvailable,
    )
    const unknownFrames = [
      encodePluginMessageItem({ itemType: 'uninstalled-swap-v9', data: offer }),
      encodeFrame(
        { typeId: 27, schemaVersion: 3, minReaderVersion: 3 },
        new Map<number, Encodable>([
          [0, 'swap-negotiation-v1'],
          [1, offer],
        ]),
      ),
    ]
    for (const [registry, frames] of [
      [absent, [known, ...unknownFrames]],
      [bot, unknownFrames],
    ] as const)
      for (const frame of frames) {
        const unsupported = decodeItemFrames(
          registry,
          children([frame]),
          standaloneItemBudget(),
        )
        expect(unsupported[0]).toMatchObject({
          type: 'unsupported',
          reason: 'unknown-type',
        })
        expect(encodeItemFramesUnsupported(unsupported[0])).toBe(
          Buffer.from(frame).toString('hex'),
        )
      }
    const invalidSignature = new Uint8Array(offer)
    invalidSignature[invalidSignature.length - 1] ^= 1
    const innerVersion = new Uint8Array(offer)
    innerVersion[1] = 2
    for (const malformed of [
      Uint8Array.of(0),
      invalidSignature,
      innerVersion,
    ]) {
      const frame = encodePluginMessageItem({
        itemType: 'swap-negotiation-v1',
        data: malformed,
      })
      expect(
        decodeItemFrames(bot, children([frame]), standaloneItemBudget())[0],
      ).toMatchObject({
        type: 'unsupported',
        reason: 'malformed',
        frame: Buffer.from(frame).toString('hex'),
      })
    }
    const budget = standaloneItemBudget()
    for (let i = 0; i < 2; i++)
      budget.decodeCbor(
        encodeCanonical(
          Array.from({ length: MAX_CONTAINERS / 2 - 2 }, () => []),
        ),
      )
    expect(() => decodeItemFrames(bot, children([known]), budget)).not.toThrow()
    expect(() => decodeItemFrames(bot, children([known]), budget)).toThrow(
      MessageItemBudgetExceededError,
    )
    const responses = await Promise.all(
      (['accept', 'reject'] as const).map(async kind =>
        must(
          encodeSignedSwapEvent(
            must(await buildNegotiationResponse(context, offer, kind, signB)),
          ),
        ),
      ),
    )
    const items: ApplicationMessageItem[] = [offer, ...responses].map(
      bytes => ({
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: Buffer.from(bytes).toString('hex') },
      }),
    )
    async function roundTrip(
      sender: Seat,
      recipient: Seat,
      values: ApplicationMessageItem[],
    ) {
      f.setMailbox(recipient.mailbox)
      const sent = await f.chain.directMessages.send({
        wallet: sender.wallet,
        recipient: recipient.wallet.identity.address,
        items: values,
        stampValue: STAMP,
        conversationId,
      })
      f.setMailbox(undefined)
      const received = await f.chain.directMessages.fetchSince({
        wallet: recipient.wallet,
        sinceMs: recipient.since,
      })
      const message = received.find(m => m.payloadDigest === sent.payloadDigest)
      expect(message?.items).toEqual(values)
      expect(message?.conversationId).toBe(
        '39393939-3939-3939-3939-393939393939',
      )
      if (!message) throw Error('No encrypted delivery')
      recipient.since = Math.max(recipient.since, message.receivedTime)
      expect(JSON.parse(JSON.stringify(message.items))).toEqual(values)
      const registry = recipient === alice ? app : bot
      for (const item of message.items) {
        if (item.type !== 'application')
          throw Error('Expected application item')
        const value = item.value as { eventHex: string }
        expect(registry.encodeItem(item).bytes).toEqual(
          new Uint8Array(Buffer.from(value.eventHex, 'hex')),
        )
      }
      const forbiddenProvider = new Proxy({} as Provider, {
        get() {
          throw new Error('Inert hydration accessed provider')
        },
      })
      const hydrated = await registry.hydrateItems(message, forbiddenProvider)
      expect(hydrated.map(h => h.kind)).toEqual(values.map(() => 'hydrated'))
    }
    await roundTrip(bob, alice, items.slice(1)) // response before either side has received an offer
    await roundTrip(alice, bob, items)
    await roundTrip(bob, alice, items)
    expect(items.map(i => app.previewText(i))).toEqual([
      'Swap offer',
      'Swap acceptance message',
      'Swap rejection message',
    ])
    expect(bot.types()).toEqual([
      ...createDefaultMessageItemRegistry(
        pluginCapabilitiesNotYetAvailable,
      ).types(),
      'swap-negotiation-v1',
    ])
  } finally {
    await f.close()
  }
}, 120000)
