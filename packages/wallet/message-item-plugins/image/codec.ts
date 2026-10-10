import type { ImageItem } from '@frank/cashweb/types/messages'

import { cborItemCodec, longStr, req } from '../shared/cbor-fields'

/** An inline image is a data URI. It can never be larger than one encrypted message holds. */
export const MAX_IMAGE_BYTES = 524_288

export const imageCodec = cborItemCodec<ImageItem>('image', {
  // An inline image can exceed the CBOR profile's text-string limit, so it travels as bytes.
  image: req(0, longStr(MAX_IMAGE_BYTES, 1)),
})
