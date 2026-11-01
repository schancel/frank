import {
  encodeFrame,
  encodePluginMessageItem,
  toHex,
  TYPE_PLUGIN_MESSAGE_ITEM,
  PLUGIN_MESSAGE_ITEM,
  type Encodable,
} from '../src'
/** Source for the binary/MIME corpus. Rust deliberately retains this generic plugin type. */
export function blobMessageItemCorpus() {
  const cases = [
    {
      id: 'empty-file',
      itemType: 'blob',
      mimeType: 'application/octet-stream',
      data: new Uint8Array(),
    },
    {
      id: 'non-utf8-file',
      itemType: 'blob',
      mimeType: 'application/x-frank-example',
      data: Uint8Array.of(0, 255, 128),
    },
    {
      id: 'unknown-plugin',
      itemType: 'future-blob',
      mimeType: 'image/png',
      data: Uint8Array.of(137, 80, 78, 71),
    },
  ]
  const frames = cases.map(({ id, ...item }) => ({
    id,
    frameHex: toHex(encodePluginMessageItem(item)),
    expected: 'parsed',
    itemType: item.itemType,
    mimeType: item.mimeType,
    dataHex: toHex(item.data),
  }))
  const invalid = encodeFrame(
    { typeId: TYPE_PLUGIN_MESSAGE_ITEM, schemaVersion: 1, minReaderVersion: 1 },
    new Map<number, Encodable>([
      [PLUGIN_MESSAGE_ITEM.itemType, 'blob'],
      [PLUGIN_MESSAGE_ITEM.data, Uint8Array.of(255)],
      [PLUGIN_MESSAGE_ITEM.mimeType, 'text/html;active=yes'],
    ]),
  )
  return {
    format: 'frank-binary-plugin-v1',
    frames: [
      ...frames,
      {
        id: 'invalid-mime-header',
        frameHex: toHex(invalid),
        expected: 'schema',
      },
    ],
  }
}
