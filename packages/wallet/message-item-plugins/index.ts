/**
 * A message's `items` (`MessageItem[]`, `@frank/cashweb/types/messages`) has historically been
 * consumed by hand-written `switch`/`if-else` chains scattered across the frontend, one per
 * concern: `app/src/components/chat/messages/ChatMessage.vue` had two independent switches (one
 * for which sub-component to render, one for bubble sizing), and `app/src/stores/chats.ts` had
 * four more (two near-duplicate stealth-value tallies, sidebar preview text, notification body
 * text). Adding one new item type meant touching six switches across three files -- and two of
 * them already silently dropped types they didn't handle (`p2pkh` in rendering, `reply`/`p2pkh` in
 * preview text) rather than erroring.
 *
 * This registry replaces all of that with one plugin object per type. It's deliberately NOT a
 * dynamically-loadable/lazy-loaded plugin system (no code-splitting, no runtime registration from
 * outside this codebase) -- that's a real future direction (a "plugin store" for third-party
 * renderers) but explicitly out of scope for now. This is a static, compile-time registry whose
 * only job is killing the switch-case duplication above.
 *
 * Isomorphic on purpose: lives in `@frank/wallet` (no Vue dependency) so both the frontend (`app/`)
 * and any Node-side bot (`packages/bot`, e.g. a blackjack dealer) can hydrate/verify a message's
 * items with the *exact same* trust logic. See `hydrate()`'s own doc comment for why that matters.
 */
import { Provider } from 'ethers'

import { Message, MessageItem } from '@frank/cashweb/types/messages'

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

export interface MessageItemPlugin<
  TRaw extends MessageItem = MessageItem,
  THydrated = TRaw,
  TState = void,
> {
  type: TRaw['type']
  /** The one place a raw, just-deserialized item (still just whatever `JSON.parse` produced) gets
   * turned into the trusted object the full-bubble renderer and any bot game logic use --
   * reconciling (or overriding) any self-reported field against real on-chain data via `context`.
   * May be async (e.g. looking up an externally-referenced transaction), since it's only ever
   * called from already-async call sites (rendering a full message, or a bot processing an
   * incoming move) -- never from a synchronous getter. Called once, right after
   * `deserializeMessageItems` produces the raw array. */
  hydrate(raw: TRaw, context: MessageItemContext): THydrated | Promise<THydrated>
  /** Short human-readable summary for the sidebar chat-list preview and desktop notifications --
   * the single implementation both previously hand-rolled separately (and inconsistently).
   * Deliberately synchronous and operates on the *raw* item, not the hydrated one: both call sites
   * are synchronous Pinia getters, and a one-line preview has never needed verified amounts (it
   * didn't before this registry existed either -- see this file's header). */
  previewText(raw: TRaw): string
  /** Only for value-carrying types (e.g. a legacy stealth payment) -- omit entirely for types that
   * never carry value of their own. A plain sort/badge-value `number`, not a `bigint` wei amount --
   * matches the pre-existing behavior this replaces exactly (it already mixed Lotus satoshi-style
   * numbers and a stealth item's own `amount: number` as one abstract "value" unit; not something
   * this refactor changes). Same raw-item, synchronous constraint as `previewText`, and the same
   * behavior-preserving caveat: this reads whatever the type already read before this registry
   * existed (e.g. stealth's own self-reported `amount`), not a chain-verified figure -- fixing that
   * trust gap is a separate, already-tracked concern (ticket #60), not part of this refactor. A
   * type that needs a real verified wei amount (e.g. blackjack's wager) should use `hydrate`/
   * `reduceState` instead, not this hook. */
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
   * about a thread's current state. Takes the *hydrated* item (unlike the other hooks above) since
   * game state genuinely needs verified data (e.g. a verified wager amount). Omit for types with no
   * threading. */
  reduceState?(
    prevState: TState | undefined,
    hydrated: THydrated,
    context: MessageItemContext,
  ): TState
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, MessageItemPlugin<any, any, any>>()

export function registerMessageItemPlugin<
  TRaw extends MessageItem,
  THydrated = TRaw,
  TState = void,
>(plugin: MessageItemPlugin<TRaw, THydrated, TState>): void {
  // Overwriting (not throwing on) a re-registration is deliberate: Vite's dev-mode HMR can
  // re-execute a side-effecting registration module (e.g. `built-in.ts`) independently of whether
  // the *importing* module also reloaded, and this is a small, developer-controlled static registry
  // (never untrusted/dynamically-loaded plugins) -- there's no real safety property a hard throw
  // would protect here, only a real dev-mode footgun it would introduce.
  registry.set(plugin.type, plugin)
}

export function getMessageItemPlugin(
  type: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): MessageItemPlugin<any, any, any> | undefined {
  return registry.get(type)
}

/** Hydrates every item on `message` via its registered plugin, in order. Throws (rather than
 * silently dropping, as the old switches did) for a type with no registered plugin -- see this
 * file's header for why that used to be a real, live bug. */
export async function hydrateMessageItems(
  message: Message,
  provider: Provider,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Array<{ item: MessageItem; hydrated: any; plugin: MessageItemPlugin<any, any, any> }>> {
  return Promise.all(
    message.items.map(async (item, index) => {
      const plugin = getMessageItemPlugin(item.type)
      if (!plugin) {
        throw new Error(`No message item plugin registered for type ${item.type}`)
      }
      const hydrated = await plugin.hydrate(item, { message, index, provider })
      return { item, hydrated, plugin }
    }),
  )
}

/** Synchronous preview text for one item, via its plugin's `previewText`. Throws for an
 * unregistered type -- callers that want "nothing to show" for a missing chat/message (a real
 * state, not an error) should check for that *before* calling this, same as `getLatestMessage`'s
 * own `!chat`/`nMessages === 0` checks already did before this registry existed. */
export function getMessageItemPreview(item: MessageItem): string {
  const plugin = getMessageItemPlugin(item.type)
  if (!plugin) {
    throw new Error(`No message item plugin registered for type ${item.type}`)
  }
  return plugin.previewText(item)
}

/** Synchronous sort/badge value for a whole message: `messageStampPrice`-equivalent callers still
 * pass in separately, summed with every item's `tallyValue` (types with no `tallyValue` hook
 * contribute 0) -- the exact shape `stores/chats.ts`'s two near-duplicate stealth-tally switches
 * used to hand-roll independently. */
export function tallyMessageItemsValue(items: MessageItem[]): number {
  return items.reduce((total, item) => {
    const plugin = getMessageItemPlugin(item.type)
    return total + (plugin?.tallyValue?.(item) ?? 0)
  }, 0)
}
