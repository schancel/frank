import { createRoutes } from './routes'
import AvuDetails from '../pages/AvuDetails.vue'

jest.mock('../accounts/session', () => ({ accountStatus: { status: 'ready' } }))

test('AVU details is a dedicated page under the main application layout', async () => {
  const root = createRoutes().find(route => route.path === '/')!
  const route = root.children!.find(child => child.path === 'avu')!
  expect(route).toBeDefined()
  const load = route.component as () => Promise<{ default: unknown }>
  expect((await load()).default).toBe(AvuDetails)
})
