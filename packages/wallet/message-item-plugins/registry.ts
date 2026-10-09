/**
 * The message-item registry contract: what a message-item plugin is, what a registry offers, and
 * what a plugin is lent when it is installed.
 *
 * A registry is an ordinary object. Nothing is registered when a module is imported: a plugin is
 * a directory under `message-item-plugins/<type>/` whose `plugin.ts` exports one
 * `init…Plugin(registry, capabilities)` function, and a composition function (for example
 * `./default-registry.ts`) builds a registry and calls the `init` of every plugin its consumer
 * supports. Wallet send, receive and custody code depends on this file only; it must never import
 * a plugin. This file therefore imports no plugin and no wallet implementation.
 *
 * How a plugin encodes its item is the plugin's own business. `encode` returns bytes and `decode`
 * reads them; the wallet and messaging layers carry those bytes without parsing them and do not
 * require any particular encoding.
 */
import type { Provider } from 'ethers'

import type { Message, MessageItem } from '@frank/cashweb/types/messages'

/** Everything a plugin's `hydrate()` needs beyond the raw item itself: the whole message it came
 * from (so a plugin can read `stampPayments`/`outpoints`/`stampValueWei` -- money-carrying types
 * must never trust a self-reported amount field on the item; only what's verifiably attached to or
 * referenced by the message counts), the item's own position (for messages that ever carry more
 * than one item), and a live chain provider for a plugin that needs to look up an *externally*
 * referenced transaction (e.g. a game wager sent as its own plain transfer, referenced by hash
 * rather than folded into the message's own stamp payment). */
export interface MessageItemContext {
  message: Message
  index: number
  provider: Provider
}

// ---------------------------------------------------------------------------------------------
// Capabilities lent to a plugin
// ---------------------------------------------------------------------------------------------

/** Which of the wallet's spend public keys a plugin wants. */
export interface MessageItemSpendPublicKeyRequest {
  /** The asking plugin's item type. Must equal the type the capabilities were bound to. */
  pluginType: string
  /** The canonical chain identifier (`docs/protocol/chains/v1.json`). */
  chainIdentifier: string
}

/** Where a coin sits: a UTXO, or one `[account, nonce]` state of an account chain. */
export type MessageItemCoinLocation =
  | { kind: 'utxo'; txId: string; outputIndex: number }
  | { kind: 'account'; account: string; nonce: number }

/** How the wallet obtains the key of a coin a plugin reports. */
export type MessageItemCoinKey =
  /** The wallet's spend key for the chain, tweaked by this scalar (big-endian, for the curve the
   * chain uses). The WALLET adds the tweak to its spend private key; the plugin never sees the
   * result. The plugin computed the matching public key itself from `spendPublicKey` (P + t*G). */
  | { kind: 'spend-key-tweak'; tweak: Uint8Array }
  /** A private key the plugin generated itself (an ephemeral or escrow secret). Never a wallet
   * root, identity or spend key: a plugin is never given one to pass back. */
  | { kind: 'private-key'; privateKey: Uint8Array }

/** "There is a spendable output here, and this is its key." */
export interface MessageItemAddCoinRequest {
  /** The reporting plugin's item type, so the coin is attributable and filterable. Must equal the
   * type the capabilities were bound to. */
  pluginType: string
  chainIdentifier: string
  location: MessageItemCoinLocation
  /** In the chain's smallest unit. */
  amount: bigint
  key: MessageItemCoinKey
}

/** `addCoin`'s only answer: an acknowledgement. No key material comes back. */
export interface MessageItemAddCoinResult {
  coinId: string
}

/** What a plugin asks the wallet to execute, per chain family. Only the EVM variant is defined;
 * the others are named so that no family is forced into EVM terms, and are refused until their
 * own shape is designed. */
export type MessageItemTransactionCall =
  /** An EVM contract call or plain transfer. `value` is in wei. */
  | { family: 'evm'; to: string; data: Uint8Array; value: bigint }
  /** Placeholder: a UTXO spend to a script. Not yet specified. */
  | { family: 'bitcoin'; notYetSpecified: never }
  /** Placeholder: a Solana instruction set. Not yet specified. */
  | { family: 'solana'; notYetSpecified: never }

/**
 * "Wallet, please execute this transaction." The plugin describes the call; it never signs and
 * never holds a key.
 *
 * The wallet chooses and reserves the funding coins from its one pool. The plugin may only narrow
 * that choice with `spendFrom`. The wallet records the operation in its journal before it signs or
 * broadcasts, and owns retries and recovery. The wallet side decides whether the user must confirm
 * the request; a plugin cannot bypass that.
 */
export interface MessageItemTransactionRequest {
  /** The asking plugin's item type, so the operation is attributable. Must equal the type the
   * capabilities were bound to. */
  pluginType: string
  chainIdentifier: string
  call: MessageItemTransactionCall
  /** Narrows which coins may fund the call: only coins of this plugin's kind, or specific coins
   * this plugin added earlier through `addCoin`. Absent: the wallet chooses freely. */
  spendFrom?:
    | { kind: 'own-plugin-coins' }
    | { kind: 'coins'; coinIds: string[] }
  /** Plain-language reason, shown to the user when the wallet asks for confirmation. */
  purpose: string
}

/** How a requested transaction stands. Relay or mempool acceptance is not settlement. */
export type MessageItemTransactionOutcome =
  | { status: 'pending' }
  | { status: 'declined' }
  | { status: 'confirmed'; transactionId: string }
  | { status: 'failed'; transactionId?: string; reason: string }

/** A handle on the wallet's operation. Never raw signed bytes for the plugin to broadcast. */
export interface MessageItemTransactionHandle {
  operationId: string
  outcome(): Promise<MessageItemTransactionOutcome>
}

export type MessageItemCapabilityName =
  | 'spendPublicKey'
  | 'addCoin'
  | 'requestTransaction'

/**
 * Everything one plugin is lent at `init`, already bound to that plugin's type by composition.
 * Exactly three things, and no signing: a plugin is never handed a root, identity or spend
 * private key, and never receives signed bytes.
 */
export interface MessageItemPluginCapabilities {
  /** The wallet's spend PUBLIC key for a chain, in the chain family's own serialization (33-byte
   * compressed SEC1 for secp256k1 chains, 32 bytes for ed25519 chains), so the plugin can compute
   * tweaked public keys and addresses itself. Never private material. */
  spendPublicKey(request: MessageItemSpendPublicKeyRequest): Promise<Uint8Array>
  /** Adds a coin of a plugin kind to the wallet's pool. Once there, the wallet spends it like any
   * other coin. */
  addCoin(request: MessageItemAddCoinRequest): Promise<MessageItemAddCoinResult>
  /** Asks the wallet to fund, record, sign and broadcast a transaction the plugin describes. */
  requestTransaction(
    request: MessageItemTransactionRequest,
  ): Promise<MessageItemTransactionHandle>
}

/** What composition supplies: a capabilities object bound to each plugin type it installs. An
 * implementation must refuse a request whose `pluginType` is not the bound one. */
export interface MessageItemCapabilityProvider {
  forPlugin(pluginType: string): MessageItemPluginCapabilities
}

/** A capability exists in the contract but the host has not provided a working implementation. */
export class MessageItemCapabilityUnavailableError extends Error {
  readonly pluginType: string
  readonly capability: MessageItemCapabilityName

  constructor(pluginType: string, capability: MessageItemCapabilityName) {
    super(
      `Message item plugin '${pluginType}' asked for '${capability}', which this host does not provide yet`,
    )
    this.name = 'MessageItemCapabilityUnavailableError'
    this.pluginType = pluginType
    this.capability = capability
    Object.setPrototypeOf(this, MessageItemCapabilityUnavailableError.prototype)
  }
}

/**
 * The capability provider for a host that cannot serve plugins yet. Every method rejects with
 * {@link MessageItemCapabilityUnavailableError}, so a plugin can never silently fall back to a raw
 * wallet key. Named for what it is: replace it with the wallet's implementation, do not work
 * around it.
 */
export const pluginCapabilitiesNotYetAvailable: MessageItemCapabilityProvider =
  {
    forPlugin(pluginType) {
      const unavailable = (capability: MessageItemCapabilityName) => () =>
        Promise.reject(
          new MessageItemCapabilityUnavailableError(pluginType, capability),
        )
      return {
        spendPublicKey: unavailable('spendPublicKey'),
        addCoin: unavailable('addCoin'),
        requestTransaction: unavailable('requestTransaction'),
      }
    },
  }

/** A plugin `init` was called without the capabilities object it must be given. */
export class MessageItemPluginCapabilitiesMissingError extends Error {
  readonly pluginType: string

  constructor(pluginType: string) {
    super(
      `Message item plugin '${pluginType}' cannot be initialised without its capabilities`,
    )
    this.name = 'MessageItemPluginCapabilitiesMissingError'
    this.pluginType = pluginType
    Object.setPrototypeOf(
      this,
      MessageItemPluginCapabilitiesMissingError.prototype,
    )
  }
}

/** Called first by every plugin `init`: a plugin is never installed without its capabilities. */
export function requirePluginCapabilities(
  pluginType: string,
  capabilities: MessageItemPluginCapabilities,
): MessageItemPluginCapabilities {
  const given = capabilities as MessageItemPluginCapabilities | undefined
  if (
    !given ||
    typeof given.spendPublicKey !== 'function' ||
    typeof given.addCoin !== 'function' ||
    typeof given.requestTransaction !== 'function'
  ) {
    throw new MessageItemPluginCapabilitiesMissingError(pluginType)
  }
  return capabilities
}

// ---------------------------------------------------------------------------------------------
// The plugin
// ---------------------------------------------------------------------------------------------

export interface MessageItemPlugin<
  TRaw extends MessageItem = MessageItem,
  THydrated = TRaw,
  TState = void,
> {
  type: TRaw['type']
  /** The one place a raw, just-deserialized item gets turned into the trusted object the
   * full-bubble renderer and any bot game logic use -- reconciling (or overriding) any
   * self-reported field against real on-chain data via `context`. May be async (e.g. looking up an
   * externally-referenced transaction), since it's only ever called from already-async call sites
   * (rendering a full message, or a bot processing an incoming move) -- never from a synchronous
   * getter. */
  hydrate(
    raw: TRaw,
    context: MessageItemContext,
  ): THydrated | Promise<THydrated>
  /** Short human-readable summary for the sidebar chat-list preview and desktop notifications.
   * Deliberately synchronous and operates on the *raw* item, not the hydrated one: both call sites
   * are synchronous Pinia getters, and a one-line preview has never needed verified amounts. */
  previewText(raw: TRaw): string
  /** This item as bytes. The encoding is the plugin's choice and is opaque to every caller. Throws
   * {@link MessageItemEncodeError} for an item the plugin's own schema does not allow. */
  encode(raw: TRaw): Uint8Array
  /** The inverse of `encode`. Validates completely and throws {@link MessageItemDecodeError} for
   * anything that is not exactly one well-formed item of this type. */
  decode(bytes: Uint8Array): TRaw
  /** Only for value-carrying types (e.g. a legacy stealth payment) -- omit entirely for types that
   * never carry value of their own. A plain sort/badge-value `number`, not a `bigint` wei amount.
   * Same raw-item, synchronous constraint as `previewText`: this reads whatever the type already
   * read before the registry existed (e.g. stealth's own self-reported `amount`), not a
   * chain-verified figure (ticket #60). A type that needs a real verified wei amount (e.g.
   * blackjack's wager) should use `hydrate`/`reduceState` instead, not this hook. */
  tallyValue?(raw: TRaw): number
  /** Groups items of this type into independent threads (e.g. one per blackjack hand) before
   * folding state with `reduceState`. Synchronous, operates on the raw item (a thread key is
   * structural, e.g. a `gameId` field -- never something that needs verification). Omit for types
   * with no notion of a thread. */
  threadKey?(raw: TRaw): string
  /** Folds one more item into a thread's evolving state (e.g. "hit" applied to `{cards:[8,5]}`
   * produces `{cards:[8,5,K], bust:false}`). `undefined` prevState means "first item in this
   * thread." Both a bot (as its own live authoritative state) and the frontend (replaying message
   * history from scratch, e.g. after a reload) call this same function, so they can never disagree
   * about a thread's current state. Takes the *hydrated* item since game state genuinely needs
   * verified data (e.g. a verified wager amount). Omit for types with no threading. */
  reduceState?(
    prevState: TState | undefined,
    hydrated: THydrated,
    context: MessageItemContext,
  ): TState
}

/** The one shape every plugin directory exports from its `plugin.ts`. */
export type MessageItemPluginInit = (
  registry: MessageItemRegistry,
  capabilities: MessageItemPluginCapabilities,
) => void

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyMessageItemPlugin = MessageItemPlugin<any, any, any>

// ---------------------------------------------------------------------------------------------
// Errors and results
// ---------------------------------------------------------------------------------------------

/** A second plugin tried to register a type that already has one. */
export class MessageItemPluginAlreadyRegisteredError extends Error {
  readonly type: string

  constructor(type: string) {
    super(`A message item plugin is already registered for type ${type}`)
    this.name = 'MessageItemPluginAlreadyRegisteredError'
    this.type = type
    Object.setPrototypeOf(
      this,
      MessageItemPluginAlreadyRegisteredError.prototype,
    )
  }
}

/** The registry was asked to encode an item whose type has no plugin. */
export class MessageItemUnsupportedError extends Error {
  readonly type: string

  constructor(type: string) {
    super(`No message item plugin registered for type ${type}`)
    this.name = 'MessageItemUnsupportedError'
    this.type = type
    Object.setPrototypeOf(this, MessageItemUnsupportedError.prototype)
  }
}

/** A plugin refused to encode an item its own schema does not allow. */
export class MessageItemEncodeError extends Error {
  readonly type: string
  readonly detail: string

  constructor(type: string, detail: string) {
    super(`Cannot encode '${type}' message item: ${detail}`)
    this.name = 'MessageItemEncodeError'
    this.type = type
    this.detail = detail
    Object.setPrototypeOf(this, MessageItemEncodeError.prototype)
  }
}

/** Bytes offered as an item of a registered type are not one well-formed item of that type. */
export class MessageItemDecodeError extends Error {
  readonly type: string
  readonly detail: string

  constructor(type: string, detail: string) {
    super(`Malformed '${type}' message item: ${detail}`)
    this.name = 'MessageItemDecodeError'
    this.type = type
    this.detail = detail
    Object.setPrototypeOf(this, MessageItemDecodeError.prototype)
  }
}

/** An item's type identifier with the plugin's own bytes for it. */
export interface EncodedMessageItem {
  type: string
  bytes: Uint8Array
}

/** `decodeItem`'s answer. An unregistered type is preserved exactly, never interpreted. */
export type DecodedMessageItem =
  | { kind: 'item'; item: MessageItem }
  | { kind: 'unsupported'; type: string; bytes: Uint8Array }

/** `hydrateItems`' answer for one item. An item with no plugin is reported, never executed. */
export type HydratedMessageItem =
  | {
      kind: 'hydrated'
      item: MessageItem
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hydrated: any
      plugin: AnyMessageItemPlugin
    }
  | { kind: 'unsupported'; item: MessageItem }

/** What a preview shows for an item whose type has no plugin. */
export const UNSUPPORTED_MESSAGE_ITEM_PREVIEW = 'Unsupported message'

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

export interface MessageItemRegistry {
  /** Adds one plugin. Throws {@link MessageItemPluginAlreadyRegisteredError} for a type that
   * already has one. */
  register<TRaw extends MessageItem, THydrated = TRaw, TState = void>(
    plugin: MessageItemPlugin<TRaw, THydrated, TState>,
  ): void
  has(type: string): boolean
  /** Registered types, in registration order. */
  types(): string[]
  get(type: string): AnyMessageItemPlugin | undefined
  /** Hydrates every item on `message` through its plugin, in order. An item with no plugin comes
   * back as `unsupported`. */
  hydrateItems(
    message: Message,
    provider: Provider,
  ): Promise<HydratedMessageItem[]>
  /** Synchronous preview text for one item; {@link UNSUPPORTED_MESSAGE_ITEM_PREVIEW} for a type
   * with no plugin. Safe to call from a UI getter. */
  previewText(item: MessageItem): string
  /** Sum of every item's `tallyValue`; a type without the hook, or without a plugin, adds 0. */
  tallyValue(items: readonly MessageItem[]): number
  /** The item's bytes from its plugin. Throws {@link MessageItemUnsupportedError} for a type with
   * no plugin and {@link MessageItemEncodeError} for an item its plugin refuses. */
  encodeItem(item: MessageItem): EncodedMessageItem
  /** The item for `bytes` from the plugin registered for `type`. An unregistered type yields an
   * `unsupported` result holding the same identifier and a copy of the same bytes. Malformed bytes
   * for a registered type throw {@link MessageItemDecodeError}. */
  decodeItem(type: string, bytes: Uint8Array): DecodedMessageItem
}

export function createMessageItemRegistry(): MessageItemRegistry {
  const plugins = new Map<string, AnyMessageItemPlugin>()

  const registry: MessageItemRegistry = {
    register(plugin) {
      if (plugins.has(plugin.type)) {
        throw new MessageItemPluginAlreadyRegisteredError(plugin.type)
      }
      plugins.set(plugin.type, plugin)
    },
    has: type => plugins.has(type),
    types: () => [...plugins.keys()],
    get: type => plugins.get(type),
    hydrateItems(message, provider) {
      return Promise.all(
        message.items.map(async (item, index): Promise<HydratedMessageItem> => {
          const plugin = plugins.get(item.type)
          if (!plugin) return { kind: 'unsupported', item }
          const hydrated = await plugin.hydrate(item, {
            message,
            index,
            provider,
          })
          return { kind: 'hydrated', item, hydrated, plugin }
        }),
      )
    },
    previewText(item) {
      const plugin = plugins.get(item.type)
      return plugin
        ? plugin.previewText(item)
        : UNSUPPORTED_MESSAGE_ITEM_PREVIEW
    },
    tallyValue(items) {
      return items.reduce(
        (total, item) =>
          total + (plugins.get(item.type)?.tallyValue?.(item) ?? 0),
        0,
      )
    },
    encodeItem(item) {
      const plugin = plugins.get(item.type)
      if (!plugin) throw new MessageItemUnsupportedError(item.type)
      return { type: item.type, bytes: plugin.encode(item) }
    },
    decodeItem(type, bytes) {
      const plugin = plugins.get(type)
      if (!plugin) return { kind: 'unsupported', type, bytes: bytes.slice() }
      const item = plugin.decode(bytes) as MessageItem
      return { kind: 'item', item }
    },
  }
  return registry
}
