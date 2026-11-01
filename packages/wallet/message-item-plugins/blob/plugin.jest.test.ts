import {
  encodeFrame,
  encodePluginMessageItem,
  projectPluginMessageItem,
  standaloneItemBudget,
  validateFrame,
  TYPE_MESSAGE_CONTENT_REVISION,
  MESSAGE_CONTENT_REVISION,
} from '@frank/codec'
import {
  pluginCapabilitiesNotYetAvailable,
  MessageItemDecodeError,
  MessageItemEncodeError,
} from '@frank/cashweb/message-items/registry'
import { createDefaultMessageItemRegistry } from '../default-registry'
import { encodeItemFrames, decodeItemFrames } from '../wire'
import { MAX_BLOB_BYTES } from './codec'
const registry = createDefaultMessageItemRegistry(
  pluginCapabilitiesNotYetAvailable,
)
function read(frames: Uint8Array[]) {
  const parsed = validateFrame(
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
    parsed.kind !== 'parsed' ||
    parsed.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION
  )
    throw new Error('expected revision')
  return decodeItemFrames(registry, parsed.typed.items, standaloneItemBudget())
}
it('carries exact opaque native bytes and one MIME header, including empty and non-UTF8 payloads', () => {
  for (const data of [
    new Uint8Array(),
    Uint8Array.of(0, 255, 128),
    new Uint8Array(MAX_BLOB_BYTES).fill(255),
  ]) {
    const item = {
      type: 'blob' as const,
      mimeType: 'application/octet-stream',
      data,
    }
    const frames = encodeItemFrames(registry, [item])
    expect(read(frames)).toEqual([item])
    const frame = validateFrame(frames[0])
    if (frame.kind !== 'parsed') throw new Error('expected parsed frame')
    expect(projectPluginMessageItem(frame)).toEqual({
      itemType: 'blob',
      mimeType: item.mimeType,
      data,
    })
  }
})
it('keeps MIME metadata separate from another plugin payload', () => {
  const item = {
    type: 'reply' as const,
    payloadDigest: 'ab'.repeat(32),
    mimeType: 'application/x-frank-reference',
  }
  expect(read(encodeItemFrames(registry, [item]))).toEqual([item])
})
it.each([
  '',
  'IMAGE/PNG',
  'image/*',
  'image/png;foo=bar',
  'text/html\r\nX: yes',
  'a/' + 'x'.repeat(127),
])('refuses invalid MIME %j', mimeType => {
  expect(() =>
    registry.encodeItem({ type: 'blob', mimeType, data: new Uint8Array() }),
  ).toThrow(MessageItemEncodeError)
})
it('refuses oversized bytes and missing MIME before execution', () => {
  expect(() =>
    registry.encodeItem({
      type: 'blob',
      mimeType: 'image/png',
      data: new Uint8Array(MAX_BLOB_BYTES + 1),
    }),
  ).toThrow(MessageItemEncodeError)
  expect(() =>
    registry.decodeItem('blob', Uint8Array.of(0), {
      budget: standaloneItemBudget(),
    }),
  ).toThrow(MessageItemDecodeError)
  const malformed = encodePluginMessageItem({
    itemType: 'blob',
    data: Uint8Array.of(255),
  })
  expect(read([malformed])[0]).toMatchObject({
    type: 'unsupported',
    itemType: 'blob',
  })
})
it('preserves unknown plugins and retired image entries as unsupported frames', () => {
  for (const itemType of ['unknown-binary', 'image']) {
    const frame = encodePluginMessageItem({
      itemType,
      mimeType: 'application/x-example',
      data: Uint8Array.of(255, 0),
    })
    expect(read([frame])[0]).toMatchObject({ type: 'unsupported', itemType })
  }
})

it('rejects optional MIME on a dedicated frame rather than silently dropping it', () => {
  expect(() =>
    encodeItemFrames(registry, [
      { type: 'text', text: 'hello', mimeType: 'text/plain' },
    ]),
  ).toThrow('MIME metadata requires the generic plugin carrier')
})
it('the conservative sizing allowance covers the maximum MIME header', () => {
  const [frame] = encodeItemFrames(registry, [
    { type: 'blob', mimeType: 'a/' + 'b'.repeat(125), data: new Uint8Array() },
  ])
  expect(frame.length).toBeLessThanOrEqual(192)
})

it('copies Buffer and subarray inputs into owned native bytes', () => {
  const data = Buffer.from([1, 0, 255, 2]).subarray(1, 3)
  const encoded = registry.encodeItem({
    type: 'blob',
    mimeType: 'application/octet-stream',
    data,
  })
  data.fill(42)
  expect(encoded.bytes).toEqual(Uint8Array.of(0, 255))
  expect(Buffer.isBuffer(encoded.bytes)).toBe(false)
})
