/**
 * App-only companion to `@frank/wallet/message-item-plugins`: how much a message item type wants
 * to grow or shrink its chat bubble. Kept separate from the wallet-side registry on purpose --
 * that one is isomorphic (no Vue), this one is Vue-only.
 *
 * Was a second, independent per-type switch in `ChatMessage.vue`'s own `bubbleSize` computed before
 * this registry existed (see that computed's own comment for the exact precedence this preserves).
 *
 * An earlier version of this file also centralized *which component* renders each type (replacing
 * `ChatMessage.vue`'s static `v-if`/`v-else-if` chain with a data-driven `<component :is>`) --
 * reverted back to the static chain after a long, ultimately-inconclusive live-debugging session hit
 * an intermittent Vue "component update" crash that a full dev-server restart made disappear
 * entirely (stale Vite/HMR module-graph state from many consecutive hot-reloads during iteration,
 * not a real bug in the dynamic-dispatch approach itself -- confirmed by reproducing and then fully
 * clearing it with the same test against a byte-identical clean restart). The static chain works
 * and is what's shipped; revisit true dynamic dispatch (needed for a genuinely new type like
 * blackjack's own move renderer) with a fresh, uninterrupted dev session rather than assuming this
 * class of crash will recur.
 */
import { MessageItem } from '@frank/cashweb/types/messages'

export interface MessageItemRenderer<TRaw extends MessageItem = MessageItem> {
  type: TRaw['type']
  /** `textLen` is the same screen-width-driven threshold `ChatMessage.vue`'s `bubbleSize` already
   * computes, passed in since only text's own check needs it. Kept as two separate wants-big/
   * wants-small hooks (rather than a single signed number summed across items) specifically to
   * preserve the original logic's exact precedence: "wants big" always wins over "wants small" when
   * a message somehow has both, it never nets them out to zero. Omit either hook for a type with no
   * opinion. */
  wantsLargeBubble?(item: TRaw, params: { textLen: number }): boolean
  wantsSmallBubble?(item: TRaw): boolean
}

const registry = new Map<string, MessageItemRenderer>()

export function registerMessageItemRenderer<TRaw extends MessageItem>(
  renderer: MessageItemRenderer<TRaw>,
): void {
  // Overwrite, not throw, on re-registration -- see the wallet-side registry's identical choice
  // (Vite HMR can re-execute this module independently of its importer; this is a small,
  // developer-controlled static registry, not untrusted dynamic plugin loading).
  registry.set(renderer.type, renderer as MessageItemRenderer)
}

export function getMessageItemRenderer(type: string): MessageItemRenderer | undefined {
  return registry.get(type)
}

registerMessageItemRenderer({
  type: 'text',
  wantsLargeBubble: (item, { textLen }) =>
    item.type === 'text' && item.text.length >= textLen,
})

registerMessageItemRenderer({
  type: 'image',
  wantsLargeBubble: item => item.type === 'image' && item.image.length > 0,
})

registerMessageItemRenderer({
  type: 'reply',
  wantsSmallBubble: item => item.type === 'reply' && !!item.payloadDigest,
})
