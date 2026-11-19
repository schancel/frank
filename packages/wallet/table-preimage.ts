/**
 * The HTLC preimage of a game table this account arbitrates (a poker or liar's dice bot's
 * table): derived, never stored.
 *
 * EXPLICIT NEW DERIVATION (AGENTS.md §6), `frank/table-htlc-preimage/v1`:
 *
 *   prk      = HKDF-Extract(SHA-256, salt = utf8("frank/table-htlc-preimage/v1"), ikm = root)
 *   preimage = HKDF-Expand(SHA-256, prk, info, 32)
 *   info     = u8(len(utf8(game))) ‖ utf8(game) ‖ tableId (exactly 16 bytes)
 *
 * `root` is the account's 32-byte messaging root (`messaging-encryption` domain root), or, for a
 * historical BIP39 account, its complete 64-byte PBKDF2 seed, as for the swap preimage
 * (`./swap-preimage`) and the conversation-ID salt. `game` is the table's game, the item type
 * of its plugin (`poker`, `liars-dice`): 1..255 UTF-8 bytes, length-prefixed so that no two
 * (game, table) pairs encode to the same info. `tableId` is the fixed-size last field: 16 bytes
 * the arbiter drew itself when it opened the table, never an id a player supplied. The hash lock
 * of every buy-in lock at the table is `sha256(preimage)`.
 *
 * The preimage depends only on the account's key material, the game and the table, so the
 * arbiter derives the same one after a restart, without storing or syncing it, and nobody else
 * can compute it. The label differs from the swap preimage's, so a table and a swap never share
 * a secret. It is a fresh 32-byte copy on every call; the caller wipes it. Pinned vectors live
 * in table-preimage.jest.test.ts; changing any of the above is a new derivation version.
 */
import { extract, expand } from '@noble/hashes/hkdf'
import { sha256 } from '@noble/hashes/sha256'

export const TABLE_PREIMAGE_LABEL = 'frank/table-htlc-preimage/v1'
/** A table id, as the derivation takes it: 16 bytes. */
export const TABLE_ID_BYTES = 16

/** What a game arbiter needs from custody to hold a table's hash lock: its preimage, and
 * nothing else. */
export interface TableSecretCapability {
  /** The 32-byte preimage of table `tableId` (16 bytes) of game `game`. A fresh copy on every
   * call; never stored by the wallet. */
  tablePreimage(input: { game: string; tableId: Uint8Array }): Uint8Array
}

export function tablePreimageInfo(
  game: string,
  tableId: Uint8Array,
): Uint8Array {
  if (typeof game !== 'string') throw new Error('Table game must be a string')
  const name = new TextEncoder().encode(game)
  if (name.length === 0 || name.length > 255)
    throw new Error('Table game must be 1..255 UTF-8 bytes')
  if (!(tableId instanceof Uint8Array) || tableId.length !== TABLE_ID_BYTES)
    throw new Error(`Table id must be exactly ${TABLE_ID_BYTES} bytes`)
  const info = new Uint8Array(1 + name.length + TABLE_ID_BYTES)
  info[0] = name.length
  info.set(name, 1)
  info.set(tableId, 1 + name.length)
  return info
}

/** The preimage, from the account root the caller owns (32-byte messaging root or 64-byte
 * historical BIP39 seed). Custody-internal: hosts reach it only through a
 * {@link TableSecretCapability}. */
export function deriveTablePreimage(
  root: Uint8Array,
  game: string,
  tableId: Uint8Array,
): Uint8Array {
  if (
    !(root instanceof Uint8Array) ||
    (root.length !== 32 && root.length !== 64)
  )
    throw new RangeError(
      'table preimage root must be the 32-byte messaging root or the 64-byte BIP39 seed',
    )
  const info = tablePreimageInfo(game, tableId)
  const prk = extract(
    sha256,
    root,
    new TextEncoder().encode(TABLE_PREIMAGE_LABEL),
  )
  try {
    return expand(sha256, prk, info, 32)
  } finally {
    prk.fill(0)
  }
}
