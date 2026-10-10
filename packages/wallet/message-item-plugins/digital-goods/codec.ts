/**
 * A digital-goods item as one canonical CBOR map, carried on the canonical direct message path in
 * the generic plugin item frame.
 *
 * It used to travel as JSON inside a text frame, where a reader could not tell it from text. That
 * form is no longer written or read: there is no reader for it here.
 */
import type { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  list,
  longText,
  oneOf,
  opt,
  req,
  struct,
  text,
} from '../shared/cbor-fields'

type CatalogEntry = NonNullable<DigitalGoodsItem['catalog']>[number]

export const digitalGoodsCodec = cborItemCodec<DigitalGoodsItem>(
  'digital-goods',
  {
    action: req(0, oneOf('catalog', 'request', 'fulfill', 'error')),
    catalog: opt(
      1,
      list(
        struct<CatalogEntry>({
          itemId: req(0, text),
          description: req(1, text),
          priceWei: req(2, text),
          // A data URI: bytes, like an image item, so it is not bound by the text-string limit.
          thumbnail: opt(3, longText),
        }),
      ),
    ),
    itemId: opt(2, text),
    message: opt(3, text),
  },
)
