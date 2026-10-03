import { initializeMonadIdentity } from './monad-identity-session'
import { useMonadWallet } from './clients'
const mockInitialize = jest.fn(async () => undefined)
const mockStatus = { status: 'fresh' }
jest.mock('../accounts/session', () => ({
  accountSession: { initialize: () => mockInitialize() },
  get accountStatus() {
    return mockStatus
  },
}))
test('normal boot opens custody and does not expose a legacy messaging wallet', async () => {
  expect(await initializeMonadIdentity()).toBe('skipped')
  mockStatus.status = 'ready'
  expect(await initializeMonadIdentity()).toBe('started')
  expect(mockInitialize).toHaveBeenCalledTimes(2)
  expect(() => useMonadWallet()).toThrow('Messaging is unavailable')
})
