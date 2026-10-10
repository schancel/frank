/**
 * A digital-goods item as one canonical CBOR map, carried on the canonical direct message path in
 * the generic plugin item frame.
 *
 * It used to travel as JSON inside a text frame, where a reader could not tell it from text. That
 * form is no longer written or read: there is no reader for it here.
 */
import type { DigitalGoodsItem } from '@frank/cashweb/types/messages'

import {
  amount,
  cborItemCodec,
  listOf,
  longStr,
  matching,
  oneOf,
  opt,
  req,
  str,
  struct,
} from '../shared/cbor-fields'
import { note } from '../shared/limits'

type CatalogEntry = NonNullable<DigitalGoodsItem['catalog']>[number]

/** The limits the vendor's catalog loader enforces on what it offers. */
export const MAX_CATALOG_ITEMS = 50
export const MAX_THUMBNAIL_BYTES = 65_536
const itemId = matching(
  /^[A-Za-z0-9_.-]{1,64}$/,
  'an item id of at most 64 letters, digits, "_", "." or "-"',
)

export const digitalGoodsCodec = cborItemCodec<DigitalGoodsItem>(
  'digital-goods',
  {
    action: req(0, oneOf('catalog', 'request', 'fulfill', 'error')),
    catalog: opt(
      1,
      listOf(
        struct<CatalogEntry>({
          itemId: req(0, itemId),
          // 200 characters at most; up to four bytes each.
          description: req(1, str(800, 1)),
          priceWei: req(2, amount),
          // A data URI: bytes, like an image item, so it is not bound by the text-string limit.
          thumbnail: opt(3, longStr(MAX_THUMBNAIL_BYTES, 1)),
        }),
        MAX_CATALOG_ITEMS,
      ),
    ),
    itemId: opt(2, itemId),
    message: opt(3, note),
  },
)
