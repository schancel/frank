import { effectScope, reactive } from 'vue'
import type { Router } from 'vue-router'
import type { useChatStore } from 'src/stores/chats'
import { useChatDeletionNavigation } from './chat-deletion-navigation'
import { accountSession } from 'src/accounts/session'

jest.mock('src/accounts/session', () => ({
  accountSession: { state: { revision: 1, account: null } },
}))

function fixture(ids: string[], target: string) {
  const conversations = Object.fromEntries(
    ids.map(id => [
      id,
      { id, address: 'same-peer', deletedAt: undefined as number | undefined },
    ]),
  )
  const store = reactive({
    conversations,
    chats: {},
    get getSortedChatOrder() {
      return ids
        .map(id => this.conversations[id])
        .filter(c => c && !c.deletedAt)
    },
    setActiveConversation: jest.fn(),
  })
  const router = { replace: jest.fn() }
  const scope = effectScope()
  const navigate = scope.run(() =>
    useChatDeletionNavigation(
      store as unknown as ReturnType<typeof useChatStore>,
      () => target,
    ),
  )
  if (!navigate) throw new Error('Missing navigation scope')
  return {
    store,
    router,
    scope,
    deleteAndNavigate(route = target) {
      store.conversations[target].deletedAt = 1
      navigate(router as unknown as Router, route, target)
    },
  }
}

describe('successful chat deletion navigation', () => {
  it.each([
    ['first', ['first', 'middle', 'last'], '/chat/middle'],
    ['middle', ['first', 'middle', 'last'], '/chat/last'],
    ['last', ['first', 'middle', 'last'], '/chat/middle'],
    ['only', ['only'], '/chat'],
  ])(
    'selects adjacent conversation after deleting %s',
    (target, ids, expected) => {
      const f = fixture(ids, target)
      f.deleteAndNavigate()
      expect(f.router.replace).toHaveBeenCalledWith(expected)
      expect(f.store.setActiveConversation.mock.calls).toEqual(
        expected === '/chat' ? [] : [[expected.slice(6)]],
      )
      f.scope.stop()
    },
  )
  it('preserves another open conversation', () => {
    const f = fixture(['first', 'other'], 'first')
    f.deleteAndNavigate('other')
    expect(f.router.replace).not.toHaveBeenCalled()
    expect(f.store.setActiveConversation).not.toHaveBeenCalled()
    f.scope.stop()
  })
  it('skips neighbours removed while deletion was pending', () => {
    const f = fixture(['first', 'middle', 'last'], 'first')
    f.store.conversations.middle.deletedAt = 1
    f.deleteAndNavigate()
    expect(f.router.replace).toHaveBeenCalledWith('/chat/last')
    f.scope.stop()
  })
  it('does not navigate in a changed account session', () => {
    const f = fixture(['first', 'last'], 'first')
    f.store.conversations.first.deletedAt = 1
    accountSession.state.revision++
    // Call the success callback only after the account changes.
    f.deleteAndNavigate()
    expect(f.router.replace).not.toHaveBeenCalled()
    f.scope.stop()
  })
})
