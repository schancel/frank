import type { ContactStateItem } from '@frank/cashweb/types/messages'

import {
  bool,
  cborItemCodec,
  chainAddress,
  req,
  timestampMs,
  type ItemCodec,
} from '@frank/cashweb/message-items/cbor-fields'

/**
 * What one device of an account notes to the account's other devices about one contact: the
 * user added it (`present`) or removed it, at `setAt`. Carried only in a note a wallet addresses
 * to itself (`SELF_ONLY_ITEM_TYPES`). No profile: every device reads that from the directory.
 */
export const contactStateCodec: ItemCodec<ContactStateItem> = cborItemCodec<ContactStateItem>(
  'contact-state',
  {
    address: req(0, chainAddress),
    present: req(1, bool),
    setAt: req(2, timestampMs),
  },
)
