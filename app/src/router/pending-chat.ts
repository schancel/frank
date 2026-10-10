/**
 * The chat a navigation is on its way to, from the click until the route is committed.
 *
 * Opening a conversation is not instant: the navigation waits for the account session and, the
 * first time, for the chat page's code. Two things follow from knowing where it is headed:
 * - the chat pane shows that the conversation is opening instead of "Select a conversation";
 * - if the page is reloaded before the navigation finishes (the dev server reloading for a new
 *   dependency, a new version of the app replacing the one that was running), the conversation
 *   the user clicked is still opened afterwards. Without this the reload came back to the URL
 *   the navigation had not yet changed, and the click was lost.
 *
 * The record is kept for the tab (sessionStorage): it ends with the tab and is removed as soon
 * as the navigation ends, whichever way.
 */
import { ref } from 'vue'

export const PENDING_CHAT_ROUTE_KEY = 'frank:pending-chat-route'

/** The chat route being opened (its full path); null when none is. */
export const pendingChatRoute = ref<string | null>(null)

interface PendingRecord {
  /** Where the navigation started: a reload resumes it only from that same place. */
  from: string
  to: string
}

function storage(): Storage | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** A navigation to a chat has started (`to`), or one to anywhere else (`null`). */
export function notePendingChatRoute(to: string | null, from = ''): void {
  pendingChatRoute.value = to
  try {
    if (to === null) storage()?.removeItem(PENDING_CHAT_ROUTE_KEY)
    else
      storage()?.setItem(
        PENDING_CHAT_ROUTE_KEY,
        JSON.stringify({ from, to } satisfies PendingRecord),
      )
  } catch {
    // No storage: the waiting state still shows; only resuming after a reload is lost.
  }
}

/** The chat navigation a reload interrupted, if any. Reading it removes the record. */
export function takeInterruptedChatRoute(): PendingRecord | undefined {
  try {
    const raw = storage()?.getItem(PENDING_CHAT_ROUTE_KEY)
    storage()?.removeItem(PENDING_CHAT_ROUTE_KEY)
    if (!raw) return undefined
    const record = JSON.parse(raw) as Partial<PendingRecord>
    return typeof record.to === 'string' &&
      record.to.startsWith('/chat/') &&
      typeof record.from === 'string'
      ? { from: record.from, to: record.to }
      : undefined
  } catch {
    return undefined
  }
}
