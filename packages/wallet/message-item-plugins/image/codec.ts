import type { ImageItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, longText, req } from '../shared/cbor-fields'

export const imageCodec = cborItemCodec<ImageItem>('image', {
  // An inline image can exceed the CBOR profile's text-string limit, so it travels as bytes.
  image: req(0, longText),
})
