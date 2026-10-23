// A client ignores a relay forwarding envelope inside an open message-item field (S8): the item
// is kept as an uninterpreted frame, never opened as type 13, and the message's other items
// survive. The Rust relay refuses the same bytes (frank-cbor tests/open_item_ignored.rs).
import { defaultContext, validateFrame } from '../src'
import {
  CONTAINER_MESSAGE_ITEM,
  FORWARDING_DELIVERY_ENVELOPE,
  TYPE_CONTAINER_MESSAGE_ITEM,
  TYPE_FORWARDING_DELIVERY_ENVELOPE,
  TYPE_MESSAGE_CONTENT_REVISION,
  TYPE_TEXT_MESSAGE_ITEM,
  TYPE_TOPIC_POST,
} from '../src/constants'
import {
  M,
  NET,
  fr,
  revision8,
  textItem,
  topicPostFrame,
} from '../fixtures/builders'

const envelope = (): Uint8Array =>
  fr(
    TYPE_FORWARDING_DELIVERY_ENVELOPE,
    M([[FORWARDING_DELIVERY_ENVELOPE.network, NET]]),
  )

function parsedRevision(items: Uint8Array[]) {
  const result = validateFrame(
    fr(TYPE_MESSAGE_CONTENT_REVISION, revision8(items)),
    defaultContext(),
  )
  if (result.kind !== 'parsed') throw new Error(`not parsed: ${result.kind}`)
  if (result.typed?.type !== TYPE_MESSAGE_CONTENT_REVISION)
    throw new Error('not a typed revision')
  return result.typed
}

describe('client handling of a forwarding envelope in an open item field (S8)', () => {
  it('accepts the message, keeps the envelope uninterpreted and the other items intact', () => {
    const forwarded = envelope()
    const revision = parsedRevision([
      textItem('before'),
      forwarded,
      textItem('after'),
    ])
    expect(revision.items).toHaveLength(3)
    const [before, ignored, after] = revision.items
    expect(before.kind).toBe('parsed')
    expect(after.kind).toBe('parsed')
    if (before.kind === 'parsed' && after.kind === 'parsed') {
      expect(before.typeId).toBe(TYPE_TEXT_MESSAGE_ITEM)
      expect(after.typeId).toBe(TYPE_TEXT_MESSAGE_ITEM)
    }
    // The same outcome as an item of a type this reader does not know (V6.1).
    expect(ignored.kind).toBe('retained')
    if (ignored.kind !== 'retained') throw new Error('not retained')
    expect(ignored.reason).toBe('unknown-type')
    expect(ignored.frame).toEqual(forwarded)
    expect('typed' in ignored).toBe(false)
  })

  it('ignores it inside a nested container too', () => {
    const container = fr(
      TYPE_CONTAINER_MESSAGE_ITEM,
      M([[CONTAINER_MESSAGE_ITEM.items, [envelope(), textItem('kept')]]]),
    )
    const [item] = parsedRevision([container]).items
    if (
      item.kind !== 'parsed' ||
      item.typed?.type !== TYPE_CONTAINER_MESSAGE_ITEM
    )
      throw new Error('container not parsed')
    expect(item.typed.items.map(c => c.kind)).toEqual(['retained', 'parsed'])
  })

  it('still refuses every other assigned non-item type in an item field', () => {
    const result = (() => {
      try {
        return validateFrame(
          fr(TYPE_MESSAGE_CONTENT_REVISION, revision8([topicPostFrame()])),
          defaultContext({
            supportedSchemas: [
              ...defaultContext().supportedSchemas,
              { typeId: TYPE_TOPIC_POST, schemaVersion: 1 },
            ],
          }),
        )
      } catch (error) {
        return error as { category?: string; stage?: string }
      }
    })()
    expect(result).toMatchObject({ category: 'semantic', stage: '8.4' })
  })

  it('a forwarding envelope as the root is still validated as type 13', () => {
    expect(() => validateFrame(envelope(), defaultContext())).toThrow()
  })
})
