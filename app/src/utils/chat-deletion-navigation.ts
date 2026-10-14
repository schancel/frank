import { watchEffect } from 'vue'
import type { Router } from 'vue-router'
import type { useChatStore } from 'src/stores/chats'
import { toChainDisplayAddress } from './chain-address'
import { openChat } from './routes'
import { accountSession } from 'src/accounts/session'

/** Retain the original neighbours: deleting a row also removes it from the live order. */
export function useChatDeletionNavigation(
  store: ReturnType<typeof useChatStore>,
  target: () => string,
) {
  const resolve = (id: string) => {
    if (store.conversations?.[id]) return store.conversations[id]
    try {
      return store.chats?.[toChainDisplayAddress(id)]
    } catch {
      return undefined
    }
  }
  let snapshot:
    | {
        id: string
        order: string[]
        conversations: typeof store.conversations
        revision: number
        account: typeof accountSession.state.account
      }
    | undefined
  watchEffect(
    () => {
      const routeId = target()
      const conversation = resolve(routeId)
      const order = store.getSortedChatOrder ?? []
      if (!conversation || !order.some(item => item.id === conversation.id))
        return
      snapshot = {
        id: conversation.id,
        order: order.map(item => item.id),
        conversations: store.conversations,
        revision: accountSession.state.revision,
        account: accountSession.state.account,
      }
    },
    { flush: 'sync' },
  )

  return (router: Router, currentRouteId: string, deletedId: string) => {
    const saved = snapshot
    if (
      !saved ||
      saved.id !== deletedId ||
      saved.conversations !== store.conversations ||
      saved.revision !== accountSession.state.revision ||
      saved.account !== accountSession.state.account
    )
      return
    // Selection can change before the router finishes navigating.
    if (store.activeConversationId && store.activeConversationId !== saved.id)
      return
    // A different conversation may have been opened while deletion was waiting.
    if (currentRouteId !== saved.id && resolve(currentRouteId)?.id !== saved.id)
      return
    const index = saved.order.indexOf(saved.id)
    const available = new Set(store.getSortedChatOrder.map(item => item.id))
    const next = [
      ...saved.order.slice(index + 1),
      ...saved.order.slice(0, index).reverse(),
    ].find(id => id !== saved.id && available.has(id))
    if (next) store.setActiveConversation(next)
    if (next) void openChat(router, next, { replace: true })
    else void router.replace('/chat')
    return true
  }
}
