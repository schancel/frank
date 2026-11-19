/** @jest-environment node */
import { createAppMessageItemRegistry, messageItems } from './message-items'
import { applicationRenderer } from './application-renderers'
import { createDefaultMessageItemRegistry } from '@frank/wallet/message-item-plugins/default-registry'
import {
  decodeItemFrames,
  encodeItemFrames,
} from '@frank/wallet/message-item-plugins/wire'
import {
  UNSUPPORTED_MESSAGE_ITEM_PREVIEW,
  pluginCapabilitiesNotYetAvailable,
} from '@frank/cashweb/message-items/registry'
import {
  TYPE_MESSAGE_CONTENT_REVISION,
  encodeCanonical,
  encodeFrame,
  encodePluginMessageItem,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type Encodable,
} from '@frank/codec'

it('explicitly installs inert negotiation in the actual app composition without changing wallet defaults', () => {
  const defaults = createDefaultMessageItemRegistry(
    pluginCapabilitiesNotYetAvailable,
  )
  const app = createAppMessageItemRegistry()
  expect(defaults.has('swap-negotiation-v1')).toBe(false)
  expect(defaults.has('newsletter-article-v1')).toBe(false)
  expect(defaults.has('article-v1')).toBe(false)
  expect(defaults.has('invoice-v1')).toBe(false)
  expect(defaults.has('mental-poker-v1')).toBe(false)
  expect(defaults.has('webrtc-call-v1')).toBe(false)
  expect(app.types()).toEqual([
    ...defaults.types(),
    'group-welcome',
    'group-control',
    'swap-negotiation-v1',
    'newsletter-article-v1',
    'article-v1',
    'invoice-v1',
    'mental-poker-v1',
    'webrtc-call-v1',
  ])
  expect(messageItems.types()).toEqual(app.types())
  expect(app).not.toBe(messageItems)
  expect(
    app.tallyValue([
      {
        type: 'application',
        itemType: 'swap-negotiation-v1',
        value: { eventHex: '00' },
      },
    ]),
  ).toBe(0)
})

it('keeps a retired swap-handshake-v1 item as unsupported and delivers the rest of the message', () => {
  // `swap-handshake-v1` was deleted (HTLC plan PR 9); the identifier stays retired. An old item
  // that still arrives is kept as its frame, never interpreted, and the text beside it arrives.
  const app = createAppMessageItemRegistry()
  expect(app.has('swap-handshake-v1')).toBe(false)
  expect(applicationRenderer('swap-handshake-v1')).toBeUndefined()
  const handshake = encodePluginMessageItem({
    itemType: 'swap-handshake-v1',
    data: encodeCanonical(new Map<number, Encodable>([[0, 1]])),
  })
  const [text] = encodeItemFrames(app, [{ type: 'text', text: 'beside it' }])
  const revision = validateFrame(
    encodeFrame(
      {
        typeId: TYPE_MESSAGE_CONTENT_REVISION,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      new Map<number, Encodable>([
        [0, 'frank'],
        [1, [handshake, text]],
      ]),
    ),
  )
  if (
    revision.kind !== 'parsed' ||
    revision.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('expected a revision')
  const received = decodeItemFrames(
    app,
    revision.typed.items,
    standaloneItemBudget(),
  )
  expect(received).toEqual([
    {
      type: 'unsupported',
      reason: 'unknown-type',
      itemType: 'swap-handshake-v1',
      frameType: 27,
      frame: toHex(handshake),
    },
    { type: 'text', text: 'beside it' },
  ])
  expect(app.tallyValue(received)).toBe(0)
  expect(
    app.previewText({
      type: 'application',
      itemType: 'swap-handshake-v1',
      value: { schemaVersion: 1 },
    }),
  ).toBe(UNSUPPORTED_MESSAGE_ITEM_PREVIEW)
})
