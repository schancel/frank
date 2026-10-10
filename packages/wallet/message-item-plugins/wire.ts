/**
 * How a registered message item travels on the canonical direct message path, stated once.
 *
 * - An item type with a dedicated frame keeps it, byte for byte: the plugin's bytes ARE that frame.
 * - Every other registered type travels in the generic plugin item frame (type 27,
 *   docs/protocol/cbor), which names the type and carries the plugin's opaque bytes. A new plugin
 *   needs no protocol allocation and no entry here.
 * - A few types are not carried at all yet (see {@link NOT_CARRIED_ITEM_TYPES}).
 * - A wallet's notes to its own other devices are carried only in a message it addresses to
 *   itself (see {@link SELF_ONLY_ITEM_TYPES}).
 * - Items read from the legacy JSON mailbox go through the same rule
 *   ({@link receiveLegacyItems}); nothing from it is delivered as it arrived.
 *
 * The send and receive code calls {@link encodeItemFrames} and {@link decodeItemFrames} and names
 * no item type. Frame type identifiers are protocol allocations and stay in this one table; a
 * plugin does not choose its own. This file imports the registry contract and the core codec only,
 * never a plugin.
 */
import {
  FrankCodecError,
  TYPE_BLACKJACK_MESSAGE_ITEM,
  TYPE_CHANNEL_UPDATE,
  TYPE_EMAIL_MESSAGE_ITEM,
  TYPE_PLUGIN_MESSAGE_ITEM,
  TYPE_STEALTH_MESSAGE_ITEM,
  TYPE_TEXT_MESSAGE_ITEM,
  defaultContext,
  encodeFrame,
  encodePluginMessageItem,
  isPluginMessageItemFrame,
  standaloneItemBudget,
  toHex,
  validateFrame,
  type ChildFrame,
  type NestedItemBudget,
  type ParsedFrame,
} from '@frank/codec'
import type {
  MessageItem,
  UnsupportedItem,
} from '@frank/cashweb/types/messages'

import {
  MessageItemDecodeError,
  MessageItemEncodeError,
  MessageItemUnsupportedError,
  type MessageItemRegistry,
} from './registry'

/** Item types that own a frame type. Their bytes on the wire are exactly that frame. */
export const DEDICATED_ITEM_FRAMES: ReadonlyMap<string, number> = new Map([
  ['text', TYPE_TEXT_MESSAGE_ITEM],
  ['blackjack-hand', TYPE_BLACKJACK_MESSAGE_ITEM],
  ['stealth', TYPE_STEALTH_MESSAGE_ITEM],
  ['channel-update', TYPE_CHANNEL_UPDATE],
  ['email', TYPE_EMAIL_MESSAGE_ITEM],
])

const ITEM_TYPE_OF_FRAME: ReadonlyMap<number, string> = new Map(
  [...DEDICATED_ITEM_FRAMES].map(([type, frameType]) => [frameType, type]),
)

/**
 * Registered types the canonical direct message path does not carry, in either direction. Sending
 * one is refused before anything is paid, as it always was; one that arrives is kept as an
 * unsupported item and is not interpreted.
 *
 * None has a safe receiver on this path yet. Four are records a wallet writes for itself:
 * - `payment-transfer`: the shape of a wallet sync record, which must enter through
 *   `applyWalletSyncItem` with wallet and chain affinity checked. Nothing sends one, and the app
 *   refuses a whole received batch that holds one, so a single such item from any peer would stop
 *   its inbox.
 * - `device-claim`: the app sends one to itself on every leadership claim; carrying it would turn
 *   each claim into a paid message.
 * - `p2pkh`: a UTXO-era item whose self-reported amount counts toward a conversation's value.
 * Two more are a peer's proposal that today's receivers would act on without checking it:
 * - `swap-offer`: receiving one enables an unconfirmed deposit; carried once the swap flow
 *   validates the offer and asks for confirmation.
 * - `blackjack-move`: the legacy dealer-bot move. Its wager is a transaction hash a receiver must
 *   verify, and no receiver on this path does; blackjack is played with `blackjack-hand` items.
 *   The type remains registered so stored messages still render.
 * Carrying any of them is a separate decision with its own receiver.
 */
export const NOT_CARRIED_ITEM_TYPES: ReadonlySet<string> = new Set([
  'payment-transfer',
  'device-claim',
  'p2pkh',
  'swap-offer',
  'blackjack-move',
])

/**
 * Registered types carried only in a message a wallet addresses to itself: the notes one device
 * of an account leaves for the account's other devices.
 *
 * - `wallet-sync`: one device's record of an account it spent, with the signed transaction as
 *   proof. A receiver hands it to `applyWalletSyncItem`, which checks chain and wallet affinity
 *   before anything changes; it is never shown as a chat message. This wallet does not send one
 *   after a native transfer today (a note is a paid message); the rule is what makes receiving
 *   one safe.
 * - `swap-record`: the record of a swap this account made, which rides in the same note as the
 *   swap's `wallet-sync` item. A host adds it to the account's swap history; it carries no
 *   outcome, which is read from the chain. Because it is carried only here, a record another
 *   person sends is never written into that history.
 *
 * - `received-coin`: how the key of one coin this account received is derived (the chain, the
 *   one-time account, and the stealth ephemeral key or the stamp's shared point and child index).
 *   The wallet writes one for the money a message brought, so the coin is found by the account's
 *   other devices and after a restore from the seed without the message. A receiver derives the
 *   key itself and records the coin only if it opens the named account; the wallet consumes the
 *   item and never hands it to a host. Because it is carried only here, another person cannot
 *   make a wallet list a coin.
 *
 * - `conversation-state`: what one device notes about a conversation for the account's other
 *   devices (it was deleted up to a time, read up to a time). The wallet does not interpret
 *   it: a host hands it to its conversation list. Because it is carried only here, another person cannot delete or
 *   change a conversation in someone's list.
 *
 * Sending one to anyone else is refused before anything is paid. One that arrives in a message
 * whose authenticated sender is not the receiving wallet's own identity is kept as an unsupported
 * item and is not interpreted: another person must not be able to hand a wallet a record of its
 * own spending. The caller says who the message is between ({@link ItemAddressing}); this module
 * does not know identities.
 */
export const SELF_ONLY_ITEM_TYPES: ReadonlySet<string> = new Set([
  'wallet-sync',
  'swap-record',
  'received-coin',
  'conversation-state',
])

/** Who one message is between, as far as the item rule needs to know. */
export interface ItemAddressing {
  /** The message's sender and recipient are the same identity, and it is this wallet's own. On
   * receive this is the AUTHENTICATED sender, never a field of the message's content. */
  selfAddressed: boolean
}

const NOT_SELF_ADDRESSED: ItemAddressing = { selfAddressed: false }

export type ItemFrameRule =
  | { carried: 'dedicated'; frameType: number }
  | { carried: 'generic'; frameType: typeof TYPE_PLUGIN_MESSAGE_ITEM }
  | { carried: 'no' }

/** The one dispatch rule. */
export function itemFrameRule(
  type: string,
  addressing: ItemAddressing = NOT_SELF_ADDRESSED,
): ItemFrameRule {
  if (NOT_CARRIED_ITEM_TYPES.has(type)) return { carried: 'no' }
  if (SELF_ONLY_ITEM_TYPES.has(type) && !addressing.selfAddressed)
    return { carried: 'no' }
  const frameType = DEDICATED_ITEM_FRAMES.get(type)
  if (frameType !== undefined) return { carried: 'dedicated', frameType }
  return { carried: 'generic', frameType: TYPE_PLUGIN_MESSAGE_ITEM }
}

/** The canonical direct message path was asked to send an item it cannot carry: its type has no
 * plugin, is one of {@link NOT_CARRIED_ITEM_TYPES}, or is one of {@link SELF_ONLY_ITEM_TYPES} in a
 * message to someone else. Nothing was encoded, paid or sent. */
export class MessageItemNotCarriedError extends MessageItemUnsupportedError {
  constructor(type: string) {
    super(type)
    this.name = 'MessageItemNotCarriedError'
    this.message = `Canonical direct messages cannot carry '${type}' items yet; nothing was paid or sent.`
    Object.setPrototypeOf(this, MessageItemNotCarriedError.prototype)
  }
}

/** A received message whose items together cost more than one message may. The whole message is
 * refused: no item of it is delivered. */
export class MessageItemBudgetExceededError extends Error {
  constructor(detail: string) {
    super(`The items of this message exceed its validation limits: ${detail}`)
    this.name = 'MessageItemBudgetExceededError'
    Object.setPrototypeOf(this, MessageItemBudgetExceededError.prototype)
  }
}

interface WatchedBudget {
  budget: NestedItemBudget
  /** Set once any use of the budget was refused for a resource limit. A plugin cannot hide it. */
  exceeded(): string | undefined
}

function watch(budget: NestedItemBudget): WatchedBudget {
  let exceeded: string | undefined
  const guard = <T>(run: () => T): T => {
    try {
      return run()
    } catch (error) {
      if (error instanceof FrankCodecError && error.category === 'resource')
        exceeded ??= error.message
      throw error
    }
  }
  return {
    budget: {
      decodeCbor: (bytes, location) =>
        guard(() => budget.decodeCbor(bytes, location)),
      openFrame: (bytes, location) =>
        guard(() => budget.openFrame(bytes, location)),
    },
    exceeded: () => exceeded,
  }
}

const detailOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

function frameTypeOf(bytes: Uint8Array): number | undefined {
  try {
    const parsed = validateFrame(
      bytes,
      defaultContext({ operation: 'generic' }),
    )
    return parsed.kind === 'parsed' ? parsed.typeId : undefined
  } catch {
    return undefined
  }
}

/**
 * The item frames of one outgoing message, in order. Pure: nothing is funded, reserved or sent.
 *
 * Throws {@link MessageItemNotCarriedError} for a type with no plugin or one this path does not
 * carry between these two parties (`addressing`; a message to anyone but oneself by default), and {@link MessageItemEncodeError} for an item its plugin refuses, an item whose own
 * bytes its plugin would not read back, or a set of items a reader would refuse as a whole. A
 * caller must do this before it pays for anything.
 */
/** One item's frame, by the dispatch rule. */
function itemFrame(
  registry: MessageItemRegistry,
  item: MessageItem,
  addressing: ItemAddressing,
): { type: string; frame: Uint8Array } {
  const type = (item as { type?: unknown } | null)?.type
  if (typeof type !== 'string')
    throw new MessageItemNotCarriedError(String(type))
  const rule = itemFrameRule(type, addressing)
  if (rule.carried === 'no' || !registry.has(type))
    throw new MessageItemNotCarriedError(type)
  const { bytes } = registry.encodeItem(item)
  if (rule.carried === 'dedicated') {
    if (frameTypeOf(bytes) !== rule.frameType)
      throw new MessageItemEncodeError(
        type,
        `its plugin did not write a type-${rule.frameType} frame`,
      )
    return { type, frame: bytes }
  }
  try {
    return {
      type,
      frame: encodePluginMessageItem({ itemType: type, data: bytes }),
    }
  } catch (error) {
    throw new MessageItemEncodeError(type, detailOf(error))
  }
}

/** The frames opened the way a reader opens one message's items. */
function openAsMessageItems(frames: readonly Uint8Array[]): ChildFrame[] {
  const revision = validateFrame(
    encodeFrame(
      { typeId: 8, schemaVersion: 1, minReaderVersion: 1 },
      new Map<number, string | Uint8Array[]>([
        [0, 'frank'],
        [1, [...frames]],
      ]),
    ),
  )
  if (revision.kind !== 'parsed' || revision.typed?.type !== 8)
    throw new Error('the items do not form a message revision')
  return revision.typed.items
}

export function encodeItemFrames(
  registry: MessageItemRegistry,
  items: readonly MessageItem[],
  addressing: ItemAddressing = NOT_SELF_ADDRESSED,
): Uint8Array[] {
  if (items.length === 0) throw new Error('A direct message needs content')
  const watched = watch(standaloneItemBudget())
  const frames = items.map(item => itemFrame(registry, item, addressing))
  // What a reader will do with these frames, done here first: the frames are opened as one
  // message's items and each item is read back by its plugin under one shared budget. A message
  // the recipient would refuse or show as unsupported is never paid for.
  let children: ChildFrame[]
  try {
    children = openAsMessageItems(frames.map(f => f.frame))
  } catch (error) {
    throw new MessageItemEncodeError(frames[0].type, detailOf(error))
  }
  children.forEach((child, index) => {
    const { type } = frames[index]
    let read: ReadItem
    try {
      read = readItemFrame(registry, child, watched, addressing)
    } catch (error) {
      // Together the items cost more than one message may: a reader would refuse them all.
      throw new MessageItemEncodeError(type, detailOf(error))
    }
    if (read.type === 'unsupported') {
      const detail = (read as { detail?: string }).detail
      throw new MessageItemEncodeError(
        type,
        `the encoded item does not read back${detail ? `: ${detail}` : ''}`,
      )
    }
  })
  return frames.map(f => f.frame)
}

type ReadItem = MessageItem | (UnsupportedItem & { detail?: string })

function unsupported(
  child: ChildFrame,
  reason: UnsupportedItem['reason'],
  itemType?: string,
  detail?: string,
): UnsupportedItem & { detail?: string } {
  return {
    type: 'unsupported',
    reason,
    ...(itemType === undefined ? {} : { itemType }),
    ...(child.typeId === undefined ? {} : { frameType: child.typeId }),
    frame: toHex(child.frame),
    ...(detail === undefined ? {} : { detail }),
  }
}

function readItemFrame(
  registry: MessageItemRegistry,
  child: ChildFrame,
  watched: WatchedBudget,
  addressing: ItemAddressing,
): ReadItem {
  // A frame type or version this reader does not know: kept exactly, never interpreted.
  if (child.kind !== 'parsed') return unsupported(child, 'unknown-type')
  let type: string
  let bytes: Uint8Array
  let frame: ParsedFrame | undefined
  if (isPluginMessageItemFrame(child)) {
    type = child.typed.itemType
    bytes = child.typed.data
    // One wire form per type: a type with a dedicated frame is not read from the generic one.
    if (DEDICATED_ITEM_FRAMES.has(type))
      return unsupported(
        child,
        'malformed',
        type,
        'this type travels in its own frame',
      )
  } else {
    const owner = ITEM_TYPE_OF_FRAME.get(child.typeId)
    if (owner === undefined) return unsupported(child, 'unknown-type')
    type = owner
    bytes = child.frame
    frame = child
  }
  if (itemFrameRule(type, addressing).carried === 'no' || !registry.has(type))
    return unsupported(child, 'unknown-type', type)
  try {
    const decoded = registry.decodeItem(type, bytes, {
      budget: watched.budget,
      ...(frame === undefined ? {} : { frame }),
    })
    if (decoded.kind !== 'item') return unsupported(child, 'unknown-type', type)
    return decoded.item
  } catch (error) {
    const exceeded = watched.exceeded()
    if (exceeded !== undefined)
      throw new MessageItemBudgetExceededError(exceeded)
    // A known type whose bytes its plugin refused. Only this item is affected.
    return unsupported(
      child,
      'malformed',
      type,
      error instanceof MessageItemDecodeError ? error.detail : detailOf(error),
    )
  }
}

/**
 * The items of one received message, in order, from the child frames its validation opened.
 * `budget` is that validation's own budget (`OpenedDirectMessage.itemBudget`); every item is
 * decoded under it. `addressing` says whether the message's authenticated sender is this wallet
 * itself; by default it is someone else.
 *
 * Never throws for one bad item: an unknown type, an unknown frame, or bytes a plugin refuses
 * becomes an `unsupported` item holding the original frame, and the other items are unaffected.
 * Throws {@link MessageItemBudgetExceededError} when the items together exceed the message's
 * limits; then no item is returned.
 */
export function decodeItemFrames(
  registry: MessageItemRegistry,
  children: readonly ChildFrame[],
  budget: NestedItemBudget,
  addressing: ItemAddressing = NOT_SELF_ADDRESSED,
): MessageItem[] {
  const watched = watch(budget)
  const items = children.map((child): MessageItem => {
    const read = readItemFrame(registry, child, watched, addressing)
    if (read.type !== 'unsupported') return read
    const item = { ...read } as UnsupportedItem & { detail?: string }
    delete item.detail
    return item
  })
  // A plugin that swallowed a refused budget still fails the message.
  const exceeded = watched.exceeded()
  if (exceeded !== undefined) throw new MessageItemBudgetExceededError(exceeded)
  return items
}

/** Longest item kept from the legacy mailbox, as JSON text. A longer one is kept as its type only. */
const MAX_LEGACY_RAW_ITEM_CHARS = 64 * 1024

/** Longest legacy message plaintext that is parsed at all. */
export const MAX_LEGACY_PLAINTEXT_CHARS = 1024 * 1024

/** `plaintext`, when it is short enough to parse. A longer one is refused as a whole, before
 * `JSON.parse` sees it, with {@link MessageItemBudgetExceededError}. */
export function boundedLegacyPlaintext(plaintext: string): string {
  if (plaintext.length > MAX_LEGACY_PLAINTEXT_CHARS)
    throw new MessageItemBudgetExceededError(
      `a legacy message of ${plaintext.length} characters`,
    )
  return plaintext
}

/**
 * The items of one message read from the legacy JSON mailbox (`PUT /message/monad`), under the
 * same receive rule as a canonical message. That transport delivers whatever JSON its sender
 * wrote, so nothing from it is an item until a plugin has read it:
 *
 * - A type that is not carried between these two parties, or has no plugin, becomes an
 *   `unsupported` item naming the type. A legacy message is never self-addressed: that transport
 *   does not authenticate its sender the way the rule requires.
 * - A carried, registered type is written by its plugin and read back from those bytes, exactly
 *   as a sender's own check does. What is returned is what the plugin read, never the object that
 *   arrived. One the plugin refuses either way becomes an `unsupported`, `malformed` item.
 *
 * An unsupported item keeps what arrived as JSON text (hex, in `frame`); it has no frame type.
 * Never throws for one item. All items of the message are read under ONE budget, as a canonical
 * message's are: when together they exceed a message's limits this throws
 * {@link MessageItemBudgetExceededError} and no item is returned.
 */
export function receiveLegacyItems(
  registry: MessageItemRegistry,
  raw: readonly unknown[],
): MessageItem[] {
  const watched = watch(standaloneItemBudget())
  const items = raw.map((value): MessageItem => {
    const type = (value as { type?: unknown } | null)?.type
    const itemType = typeof type === 'string' ? type : undefined
    const kept = (reason: UnsupportedItem['reason']): UnsupportedItem => {
      let text = ''
      try {
        text = JSON.stringify(value) ?? ''
      } catch {
        // Not serialisable: nothing of it is kept.
      }
      if (text.length > MAX_LEGACY_RAW_ITEM_CHARS) text = ''
      return {
        type: 'unsupported',
        reason,
        ...(itemType === undefined ? {} : { itemType }),
        frame: toHex(new TextEncoder().encode(text)),
      }
    }
    if (
      itemType === undefined ||
      itemFrameRule(itemType).carried === 'no' ||
      !registry.has(itemType)
    )
      return kept('unknown-type')
    try {
      const { frame } = itemFrame(
        registry,
        value as MessageItem,
        NOT_SELF_ADDRESSED,
      )
      const [child] = openAsMessageItems([frame])
      const read = readItemFrame(registry, child, watched, NOT_SELF_ADDRESSED)
      if (read.type === 'unsupported') return kept('malformed')
      return read
    } catch (error) {
      if (error instanceof MessageItemBudgetExceededError) throw error
      return kept('malformed')
    }
  })
  // A plugin that swallowed a refused budget still fails the message.
  const exceeded = watched.exceeded()
  if (exceeded !== undefined) throw new MessageItemBudgetExceededError(exceeded)
  return items
}
