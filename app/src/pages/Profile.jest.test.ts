/** @jest-environment jsdom */

import { nextTick } from 'vue'
import { shallowMount } from '@vue/test-utils'

import ProfilePage from './Profile.vue'
import { registerMonadIdentity } from '@frank/wallet/monad-identity'
import { errorNotify } from '../utils/notifications'

const mockSetRelayData = jest.fn()
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: () => ({
    profile: { name: '', bio: '', avatar: '' },
    inbox: { acceptancePrice: 0 },
    setRelayData: mockSetRelayData,
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => Promise.resolve({ identity: {} }),
}))
jest.mock('@frank/wallet/chain/monad-chain', () => ({
  loadMonadChainConfigFromEnv: () => ({ relayBaseUrl: 'http://relay' }),
}))
jest.mock('@frank/wallet/monad-identity', () => ({
  registerMonadIdentity: jest.fn(() => Promise.resolve()),
}))
jest.mock('../components/Profile.vue', () => ({
  __esModule: true,
  default: { template: '<div />' },
}))
jest.mock('../utils/notifications', () => ({ errorNotify: jest.fn() }))

const messages: Record<string, string> = {
  'profileDialog.unableContactRelay': 'RELAY_DOWN',
  'profile.nameBlank': 'NAME_BLANK',
  'profile.nameTooLong': 'NAME_TOO_LONG',
  'profile.nameForbiddenCharacters': 'NAME_FORBIDDEN',
  'profile.nameInvalidUnicode': 'NAME_INVALID_UNICODE',
}

function mountPage() {
  return shallowMount(ProfilePage, {
    global: {
      mocks: {
        $t: (key: string) => messages[key] ?? key,
        $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        $router: { go: jest.fn(), push: jest.fn() },
      },
    },
  })
}

describe('Profile page display name handling', () => {
  beforeEach(() => jest.clearAllMocks())

  it.each([
    ['', 'NAME_BLANK'],
    ['   ', 'NAME_BLANK'],
    ['A\u0000B', 'NAME_FORBIDDEN'],
    ['a'.repeat(129), 'NAME_TOO_LONG'],
  ])(
    'reports invalid name %j as %s, not a relay failure, and contacts nothing',
    async (name, message) => {
      const wrapper = mountPage()
      ;(wrapper.vm as unknown as { name: string }).name = name
      await nextTick()

      await (
        wrapper.vm as unknown as { updateRelayData(): Promise<void> }
      ).updateRelayData()

      expect(registerMonadIdentity).not.toHaveBeenCalled()
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(errorNotify).toHaveBeenCalledTimes(1)
      expect((errorNotify as jest.Mock).mock.calls[0][0].message).toBe(message)
    },
  )

  it('sends and persists the normalized name', async () => {
    const wrapper = mountPage()
    ;(wrapper.vm as unknown as { name: string }).name = ' Alice  Bob '
    await nextTick()

    await (
      wrapper.vm as unknown as { updateRelayData(): Promise<void> }
    ).updateRelayData()

    const sent = (registerMonadIdentity as jest.Mock).mock.calls[0][0]
    expect(sent.profile.name).toBe('Alice  Bob')
    expect(mockSetRelayData.mock.calls[0][0].profile.name).toBe('Alice  Bob')
    expect(errorNotify).not.toHaveBeenCalled()
  })
})
