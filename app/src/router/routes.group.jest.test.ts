import { createRoutes } from './routes'
import NewGroupPage from '../pages/NewGroup.vue'

jest.mock('../accounts/session', () => ({ accountStatus: { status: 'ready' } }))
jest.mock('../pages/AvuDetails.vue', () => ({ render: () => null }))
jest.mock('../components/chat/NewGroupForm.vue', () => ({ render: () => null }))

test('group creation is a dedicated page under the main application layout', async () => {
  const root = createRoutes().find(route => route.path === '/')!
  const route = root.children!.find(child => child.path === 'new-group')!
  expect(route).toBeDefined()
  const load = route.component as () => Promise<{ default: unknown }>
  expect((await load()).default).toBe(NewGroupPage)
})

test('group Info is a dedicated exact-ID page outside the chat layout', async () => {
  const root = createRoutes().find(route => route.path === '/')!
  const info = root.children!.find(route => route.name === 'group-info')!
  expect(info.path).toBe('chat/:conversationId/info')
  expect(info.props).toBe(true)
  const load = info.component as () => Promise<{ default: unknown }>
  expect((await load()).default).toBe(
    (await import('../pages/GroupInfo.vue')).default,
  )
  const chat = root.children!.find(route => route.path === 'chat')!
  expect(chat.children!.some(route => route.name === 'group-info')).toBe(false)
})
