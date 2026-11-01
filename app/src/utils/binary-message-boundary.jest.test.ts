import { composeChatItems, shownAttachments } from './chat-attachments'
import { png } from './image-data-uri.fixtures'
import {
  encodeItemFrames,
  decodeItemFrames,
} from '@frank/wallet/message-item-plugins/wire'
import { createBotMessageItemRegistry } from '../../../packages/bot/src/message-items'
import {
  encodeFrame,
  validateFrame,
  standaloneItemBudget,
  TYPE_MESSAGE_CONTENT_REVISION,
  MESSAGE_CONTENT_REVISION,
} from '@frank/codec'
it('composes native binary content that the actual headless bot registry reads and the image view accepts', () => {
  const dataUrl = png(3, 2)
  const items = composeChatItems('![picture](attachment:7)', [
    { id: '7', name: 'picture', dataUrl, sizeBytes: 24 },
  ])
  const registry = createBotMessageItemRegistry()
  const frames = encodeItemFrames(registry, items)
  const content = validateFrame(
    encodeFrame(
      {
        typeId: TYPE_MESSAGE_CONTENT_REVISION,
        schemaVersion: 1,
        minReaderVersion: 1,
      },
      new Map<number, string | Uint8Array[]>([
        [MESSAGE_CONTENT_REVISION.network, 'frank'],
        [MESSAGE_CONTENT_REVISION.items, frames],
      ]),
    ),
  )
  if (
    content.kind !== 'parsed' ||
    content.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('expected content')
  const received = decodeItemFrames(
    registry,
    content.typed.items,
    standaloneItemBudget(),
  )
  expect(received).toEqual(items)
  expect(received[1]).toMatchObject({
    type: 'blob',
    mimeType: 'image/png',
    data: expect.any(Uint8Array),
  })
  expect(shownAttachments(received)).toHaveLength(1)
  expect(shownAttachments(received)[0].data).toEqual(
    (items[1] as { data: Uint8Array }).data,
  )
})
