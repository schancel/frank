/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import ProfilePage from './Profile.vue'
import { readFileSync } from 'fs'
import { join } from 'path'
import { useProfileStore } from 'src/stores/my-profile'
import { useActiveWallet } from 'src/composables/useActiveWallet'
import { registerMonadIdentityCbor } from '@frank/wallet/monad-identity'

const mockSetRelayData = jest.fn()
jest.mock('src/stores/my-profile', () => ({
  useProfileStore: jest.fn(() => ({
    profile: { name: 'Alice', bio: 'Crypto enthusiast', avatar: 'data:image/png;base64,123' },
    inbox: { acceptancePrice: 100 },
    setRelayData: mockSetRelayData,
  })),
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('@frank/wallet/monad-identity', () => ({
  registerMonadIdentityCbor: jest.fn(),
}))

jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
}))

jest.mock('src/utils/navigate-back', () => ({
  navigateBack: jest.fn(),
}))

describe('Profile.vue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('renders profile editor and actions without legacy protobuf registration', () => {
    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: {
          Profile: { template: '<div data-test="profile-component"></div>' },
          'q-page-container': { template: '<div><slot /></div>' },
          'q-page': { template: '<div><slot /></div>' },
          'q-card': { template: '<div><slot /></div>' },
          'q-card-section': { template: '<div><slot /></div>' },
          'q-card-actions': { template: '<div><slot /></div>' },
          'q-btn': { template: '<button><slot /></button>' },
        },
      },
    })

    expect(wrapper.find('[data-test="profile-component"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="profile-cancel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="profile-update"]').exists()).toBe(true)
    const source = readFileSync(join(__dirname, 'Profile.vue'), 'utf8')
    // Must NOT use legacy protobuf registerMonadIdentity, must use registerMonadIdentityCbor
    expect(source).not.toMatch(/registerMonadIdentity\(/)
    expect(source).toMatch(/registerMonadIdentityCbor/)
  })

  it('saves updated profile locally and publishes CBOR identity when wallet active', async () => {
    const mockWallet = {
      identity: { address: { raw: '0x1234567890123456789012345678901234567890' } },
      relayBaseUrl: 'https://127.0.0.1:18443',
    }
    ;(useActiveWallet as jest.Mock).mockResolvedValue(mockWallet)

    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: {
          Profile: { template: '<div data-test="profile-component"></div>' },
          'q-page-container': { template: '<div><slot /></div>' },
          'q-page': { template: '<div><slot /></div>' },
          'q-card': { template: '<div><slot /></div>' },
          'q-card-section': { template: '<div><slot /></div>' },
          'q-card-actions': { template: '<div><slot /></div>' },
          'q-btn': { template: '<button><slot /></button>' },
        },
      },
    })

    // Modify name
    ;(wrapper.vm as any).name = 'Bob'
    await (wrapper.vm as any).updateRelayData()

    expect(mockSetRelayData).toHaveBeenCalledWith({
      profile: expect.objectContaining({ name: 'Bob' }),
      inbox: expect.objectContaining({ acceptancePrice: 100 }),
    })
    expect(registerMonadIdentityCbor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: mockWallet.identity,
        profile: expect.objectContaining({ name: 'Bob' }),
        relayBaseUrl: 'https://127.0.0.1:18443',
      }),
    )
  })
})
