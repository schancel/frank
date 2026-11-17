import { createRoutes } from './routes'
import NewGroupPage from '../pages/NewGroup.vue'

jest.mock('../accounts/session', () => ({ accountStatus: { status: 'ready' } }))
jest.mock('../pages/AvuDetails.vue', () => ({ render: () => null }))
jest.mock('../pages/Chat.vue', () => ({ render: () => null }))
jest.mock('../components/chat/NewGroupForm.vue', () => ({ render: () => null }))

test('group creation is a dedicated page under the main application layout', async () => {
  const root = createRoutes().find(route => route.path === '/')!
  const route = root.children!.find(child => child.path === 'new-group')!
  expect(route).toBeDefined()
  const load = route.component as () => Promise<{ default: unknown }>
  expect((await load()).default).toBe(NewGroupPage)
})

test('group Info shares the chat layout and default component while mapping its exact ID', async () => {
  const root = createRoutes().find(route => route.path === '/')!
  expect(root.children!.some(route => route.name === 'group-info')).toBe(false)
  const chat = root.children!.find(route => route.path === 'chat')!
  const normal = chat.children!.find(route => route.path === ':address')!
  const info = chat.children!.find(route => route.name === 'group-info')!
  expect(info.path).toBe(':address/info')
  const loadChat = normal.component as () => Promise<{ default: unknown }>
  const loadRetained = info.components!.default as () => Promise<{
    default: unknown
  }>
  expect((await loadRetained()).default).toBe((await loadChat()).default)
  const props = (info.props as Record<string, (route: unknown) => unknown>)
    .groupInfo
  expect(props({ params: { address: 'exact-conversation-id' } })).toEqual({
    conversationId: 'exact-conversation-id',
  })
})
