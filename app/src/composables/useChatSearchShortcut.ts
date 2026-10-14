import type { InjectionKey } from 'vue'

/** Owned by one AppRuntime; the mounted drawer supplies the actual search action. */
export interface ChatSearchShortcut {
  register(search: () => Promise<void>): () => void
  search(): boolean
}

export const CHAT_SEARCH_SHORTCUT: InjectionKey<ChatSearchShortcut> =
  Symbol('chatSearchShortcut')
export const REVEAL_CHAT_DRAWER: InjectionKey<() => Promise<boolean>> =
  Symbol('revealChatDrawer')

export function createChatSearchShortcut(): ChatSearchShortcut {
  let search: (() => Promise<void>) | undefined
  return {
    register(action) {
      search = action
      return () => {
        if (search === action) search = undefined
      }
    },
    search() {
      if (!search) return false
      void search()
      return true
    },
  }
}
