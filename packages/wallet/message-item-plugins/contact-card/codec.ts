/**
 * A `contact-card` item as one canonical CBOR map, carried on the canonical direct message
 * path in the generic plugin item frame (type 27).
 */
import type { ContactCardItem } from '@frank/cashweb/types/messages'

import {
  cborItemCodec,
  chainAddress,
  hash32,
  listOf,
  opt,
  req,
  str,
} from '../shared/cbor-fields'

export const MAX_CONTACT_LIST_ENTRIES = 32
export const MAX_RAW_VCARD_BYTES = 65_536

export const contactCardCodec = cborItemCodec<ContactCardItem>('contact-card', {
  uid: req(0, str(256, 1)),
  fullName: req(1, str(256, 1)),
  frankAddress: opt(2, chainAddress),
  username: opt(3, str(128, 1)),
  emails: opt(4, listOf(str(320, 1), MAX_CONTACT_LIST_ENTRIES)),
  phones: opt(5, listOf(str(64, 1), MAX_CONTACT_LIST_ENTRIES)),
  organization: opt(6, str(256, 1)),
  title: opt(7, str(256, 1)),
  url: opt(8, str(2048, 1)),
  note: opt(9, str(4096)),
  avatarDataUrl: opt(10, str(MAX_RAW_VCARD_BYTES, 1)),
  rawVcard: opt(11, str(MAX_RAW_VCARD_BYTES, 1)),
  wakeupTokenHex: opt(12, hash32),
})

