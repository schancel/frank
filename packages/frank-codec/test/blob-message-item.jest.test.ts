import corpus from '../../../docs/protocol/cbor/vectors/blob-message-item.json'
import { fromHex, projectPluginMessageItem, validateFrame, toHex } from '../src'
it.each(corpus.frames)(
  'qualifies the generated binary/MIME vector $id',
  item => {
    if (item.expected === 'schema') {
      expect(() => validateFrame(fromHex(item.frameHex))).toThrow()
      return
    }
    const frame = validateFrame(fromHex(item.frameHex))
    if (frame.kind !== 'parsed')
      throw new Error('expected known generic container')
    const projected = projectPluginMessageItem(frame)
    expect(projected.mimeType).toBe(
      'mimeType' in item ? item.mimeType : undefined,
    )
    expect(toHex(projected.data)).toBe(
      'dataHex' in item ? item.dataHex : undefined,
    )
  },
)
