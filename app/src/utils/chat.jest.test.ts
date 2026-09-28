/**
 * Unit tests for `utils/chat.ts` -- `processInput`, which `ChatInput.vue`'s paste handler calls to
 * pull an image out of a paste/drop event's `DataTransferItemList`.
 */
import { processInput } from './chat'

function makeItem(
  kind: string,
  type: string,
  file: File | null,
): DataTransferItem {
  return {
    kind,
    type,
    getAsFile: () => file,
  } as unknown as DataTransferItem
}

function makeItemList(items: DataTransferItem[]): DataTransferItemList {
  return items as unknown as DataTransferItemList
}

describe('processInput', () => {
  it('returns the first image file found', () => {
    const imageFile = { name: 'photo.png' } as File
    const items = makeItemList([makeItem('file', 'image/png', imageFile)])
    return expect(processInput(items)).resolves.toBe(imageFile)
  })

  it('skips a non-file item (e.g. pasted text) and returns undefined', () => {
    const items = makeItemList([makeItem('string', 'text/plain', null)])
    return expect(processInput(items)).resolves.toBeUndefined()
  })

  it('skips a non-image file and returns undefined', () => {
    const items = makeItemList([
      makeItem('file', 'application/pdf', { name: 'doc.pdf' } as File),
    ])
    return expect(processInput(items)).resolves.toBeUndefined()
  })

  it('returns the first image when multiple items are present, ignoring later ones', () => {
    const firstImage = { name: 'first.png' } as File
    const secondImage = { name: 'second.png' } as File
    const items = makeItemList([
      makeItem('string', 'text/plain', null),
      makeItem('file', 'image/png', firstImage),
      makeItem('file', 'image/jpeg', secondImage),
    ])
    return expect(processInput(items)).resolves.toBe(firstImage)
  })

  it('returns null if the matching item has no retrievable file', () => {
    const items = makeItemList([makeItem('file', 'image/png', null)])
    return expect(processInput(items)).resolves.toBeNull()
  })

  it('returns undefined for an empty item list', () => {
    return expect(processInput(makeItemList([]))).resolves.toBeUndefined()
  })
})
