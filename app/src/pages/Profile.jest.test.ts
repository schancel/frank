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
    profile: {
      name: 'Alice',
      bio: 'Crypto enthusiast',
      avatar: 'data:image/png;base64,123',
    },
    inbox: { acceptancePrice: 100 },
    setRelayData: mockSetRelayData,
  })),
}))

jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: jest.fn(),
}))

jest.mock('@frank/wallet/monad-identity', () => {
  const actual = jest.requireActual('@frank/wallet/monad-identity')
  return {
    ...actual,
    registerMonadIdentityCbor: jest.fn(),
  }
})

jest.mock('@frank/cashweb/relay/username-client', () => ({
  ...jest.requireActual('@frank/cashweb/relay/username-client'),
  claimUsername: jest.fn(),
}))
import {
  UsernameError,
  claimUsername,
} from '@frank/cashweb/relay/username-client'

import { errorNotify } from 'src/utils/notifications'

jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
}))

jest.mock('src/utils/navigate-back', () => ({
  navigateBack: jest.fn(),
}))
import { navigateBack } from 'src/utils/navigate-back'

const defaultStubs = {
  'Profile': {
    name: 'Profile',
    template: '<div data-test="profile-component"></div>',
    props: [
      'name',
      'username',
      'usernameError',
      'location',
      'bio',
      'avatar',
      'links',
      'acceptancePrice',
      'accountType',
      'botRole',
    ],
    emits: [
      'update:name',
      'update:username',
      'update:location',
      'update:bio',
      'update:avatar',
      'update:links',
      'update:acceptancePrice',
      'update:accountType',
      'update:botRole',
    ],
  },
  'q-page-container': { template: '<div><slot /></div>' },
  'q-page': { template: '<div><slot /></div>' },
  'q-card': { template: '<div><slot /></div>' },
  'q-card-section': { template: '<div><slot /></div>' },
  'q-card-actions': { template: '<div><slot /></div>' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-separator': { template: '<hr />' },
}

describe('Profile.vue', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    HTMLCanvasElement.prototype.getContext = jest.fn(() => null)
  })

  it('renders profile editor and actions without legacy protobuf registration', () => {
    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: defaultStubs,
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
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
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

  it('validates avatar size before submitting and rejects oversized avatar with error notification', async () => {
    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: defaultStubs,
      },
    })

    // Set oversized avatar that cannot be compressed or remains oversized
    ;(wrapper.vm as any).avatar = 'data:image/png;base64,' + 'X'.repeat(70000)
    await (wrapper.vm as any).updateRelayData()

    expect(errorNotify).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ fallbackKey: 'profileDialog.avatarTooLarge' }),
    )
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(registerMonadIdentityCbor).not.toHaveBeenCalled()
  })

  it('compresses oversized avatar when compression succeeds before submitting', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
      relayBaseUrl: 'https://127.0.0.1:18443',
    }
    ;(useActiveWallet as jest.Mock).mockResolvedValue(mockWallet)

    const compressedAvatar = 'data:image/webp;base64,TINY'
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      drawImage: jest.fn(),
      fillRect: jest.fn(),
      fillStyle: '',
    })) as any
    HTMLCanvasElement.prototype.toDataURL = jest.fn(() => compressedAvatar)

    const originalImage = window.Image
    class MockImage {
      crossOrigin = ''
      width = 500
      height = 500
      naturalWidth = 500
      naturalHeight = 500
      complete = true
      _src = ''
      onload: (() => void) | null = null
      get src() {
        return this._src
      }
      set src(val: string) {
        this._src = val
        if (this.onload) this.onload()
      }
    }
    window.Image = MockImage as any

    try {
      const wrapper = mount(ProfilePage, {
        global: {
          mocks: {
            $t: (key: string) => key,
            $router: { push: jest.fn() },
            $q: { loading: { show: jest.fn(), hide: jest.fn() } },
          },
          stubs: defaultStubs,
        },
      })

      ;(wrapper.vm as any).avatar = 'data:image/png;base64,' + 'X'.repeat(70000)
      await (wrapper.vm as any).updateRelayData()

      expect(mockSetRelayData).toHaveBeenCalledWith({
        profile: expect.objectContaining({ avatar: compressedAvatar }),
        inbox: expect.objectContaining({ acceptancePrice: 100 }),
      })
      expect(registerMonadIdentityCbor).toHaveBeenCalledWith(
        expect.objectContaining({
          profile: expect.objectContaining({ avatar: compressedAvatar }),
        }),
      )
    } finally {
      window.Image = originalImage
    }
  })

  it('allows re-publishing even when profile data is identical to local store', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
      },
    })

    // Do NOT modify any fields (identical is true)
    expect((wrapper.vm as any).identical).toBe(true)
    const updateBtn = wrapper.find('[data-test="profile-update"]')
    expect(updateBtn.attributes('disabled')).toBeUndefined()

    await (wrapper.vm as any).updateRelayData()

    expect(mockSetRelayData).toHaveBeenCalledWith({
      profile: expect.objectContaining({ name: 'Alice' }),
      inbox: expect.objectContaining({ acceptancePrice: 100 }),
    })
    expect(registerMonadIdentityCbor).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: mockWallet.identity,
        profile: expect.objectContaining({ name: 'Alice' }),
        relayBaseUrl: 'https://127.0.0.1:18443',
      }),
    )
  })

  it('publishes username, location, and links when updated', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
      },
    })

    ;(wrapper.vm as any).username = 'alice_crypt'
    ;(wrapper.vm as any).location = 'Cyberspace'
    ;(wrapper.vm as any).links = [
      { type: 'github', url: 'https://github.com/alice', label: 'GitHub' },
    ]

    await (wrapper.vm as any).updateRelayData()

    // The name is claimed on the relay, signed by this account's identity key.
    expect(claimUsername).toHaveBeenCalledWith({
      relayBaseUrl: 'https://127.0.0.1:18443',
      network: 'monad-testnet',
      signer: mockWallet.identity,
      username: 'alice_crypt',
    })
    expect((wrapper.vm as any).usernameError).toBe('')
    expect(mockSetRelayData).toHaveBeenCalledWith({
      profile: expect.objectContaining({
        username: 'alice_crypt',
        location: 'Cyberspace',
        links: [
          { type: 'github', url: 'https://github.com/alice', label: 'GitHub' },
        ],
      }),
      inbox: expect.objectContaining({ acceptancePrice: 100 }),
    })
    expect(registerMonadIdentityCbor).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          username: 'alice_crypt',
          location: 'Cyberspace',
          links: [
            {
              type: 'github',
              url: 'https://github.com/alice',
              label: 'GitHub',
            },
          ],
        }),
      }),
    )
  })

  it('rejects invalid username and prevents publishing', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
      },
    })

    ;(wrapper.vm as any).username = 'inv@lid user!'
    await (wrapper.vm as any).updateRelayData()

    expect(errorNotify).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ safeMessage: 'profile.invalidUsername' }),
    )
    expect(mockSetRelayData).not.toHaveBeenCalled()
    expect(registerMonadIdentityCbor).not.toHaveBeenCalled()
  })
  it.each([
    ['taken', 'profile.usernameTaken'],
    ['not-published', 'profile.usernameNotPublished'],
    ['unreachable', 'profile.usernameUnavailable'],
    ['invalid-username', 'profile.invalidUsername'],
  ] as const)(
    'a username the relay refuses as %s is shown on the field and nothing is saved or published',
    async (code, message) => {
      ;(useActiveWallet as jest.Mock).mockResolvedValue({
        identity: {
          address: { raw: '0x1234567890123456789012345678901234567890' },
        },
        relayBaseUrl: 'https://127.0.0.1:18443',
      })
      ;(claimUsername as jest.Mock).mockRejectedValueOnce(
        new UsernameError(code),
      )

      const wrapper = mount(ProfilePage, {
        global: {
          mocks: {
            $t: (key: string) => key,
            $router: { push: jest.fn() },
            $q: { loading: { show: jest.fn(), hide: jest.fn() } },
          },
          stubs: defaultStubs,
        },
      })
      ;(wrapper.vm as any).username = 'alice'
      await (wrapper.vm as any).updateRelayData()
      await wrapper.vm.$nextTick()

      expect(
        wrapper.findComponent({ name: 'Profile' }).props('usernameError'),
      ).toBe(message)
      expect(errorNotify).toHaveBeenCalledWith(
        expect.any(UsernameError),
        expect.objectContaining({ safeMessage: message }),
      )
      expect(mockSetRelayData).not.toHaveBeenCalled()
      expect(registerMonadIdentityCbor).not.toHaveBeenCalled()

      // Saving again with a name the relay accepts clears the error and saves.
      ;(wrapper.vm as any).username = 'alice2'
      await (wrapper.vm as any).updateRelayData()
      await wrapper.vm.$nextTick()
      expect(
        wrapper.findComponent({ name: 'Profile' }).props('usernameError'),
      ).toBe('')
      expect(mockSetRelayData).toHaveBeenCalled()
      expect(registerMonadIdentityCbor).toHaveBeenCalled()
    },
  )

  it('claims no username when none is entered', async () => {
    ;(useActiveWallet as jest.Mock).mockResolvedValue({
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
      relayBaseUrl: 'https://127.0.0.1:18443',
    })
    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: defaultStubs,
      },
    })
    await (wrapper.vm as any).updateRelayData()
    expect(claimUsername).not.toHaveBeenCalled()
    expect(registerMonadIdentityCbor).toHaveBeenCalled()
  })

  it('updateRelayData saves profile, stays on profile page without navigating back, and shows notify (#1041)', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
      relayBaseUrl: 'https://127.0.0.1:18443',
    }
    ;(useActiveWallet as jest.Mock).mockResolvedValue(mockWallet)
    const mockNotify = jest.fn()

    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: {
            loading: { show: jest.fn(), hide: jest.fn() },
            notify: mockNotify,
          },
        },
        stubs: defaultStubs,
      },
    })

    await (wrapper.vm as any).updateRelayData()

    expect(navigateBack).not.toHaveBeenCalled()
    expect(mockNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'positive',
        message: 'profileDialog.savedNotification',
      }),
    )
  })

  it('cancel navigates back to previous route', () => {
    const wrapper = mount(ProfilePage, {
      global: {
        mocks: {
          $t: (key: string) => key,
          $router: { push: jest.fn() },
          $q: { loading: { show: jest.fn(), hide: jest.fn() } },
        },
        stubs: defaultStubs,
      },
    })

    ;(wrapper.vm as any).cancel()

    expect(navigateBack).toHaveBeenCalledWith(expect.anything())
  })

  it('updates links via v-model:links and persists via updateRelayData', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
      },
    })

    const profileComp = wrapper.findComponent({ name: 'Profile' })
    expect(profileComp.exists()).toBe(true)

    // Emit update:links from child
    profileComp.vm.$emit('update:links', [
      { type: 'website', url: 'https://mysite.com', label: 'My Site' },
    ])
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).links).toEqual([
      { type: 'website', url: 'https://mysite.com', label: 'My Site' },
    ])

    await (wrapper.vm as any).updateRelayData()

    expect(mockSetRelayData).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          links: [
            { type: 'website', url: 'https://mysite.com', label: 'My Site' },
          ],
        }),
      }),
    )
  })

  it('updates accountType and botRole via v-model and publishes to relay', async () => {
    const mockWallet = {
      identity: {
        address: { raw: '0x1234567890123456789012345678901234567890' },
      },
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
        stubs: defaultStubs,
      },
    })

    const profileComp = wrapper.findComponent({ name: 'Profile' })
    expect(profileComp.exists()).toBe(true)

    // Emit update:accountType and update:botRole from child
    profileComp.vm.$emit('update:accountType', 1) // Bot
    profileComp.vm.$emit('update:botRole', 2) // Faucet
    await wrapper.vm.$nextTick()

    expect((wrapper.vm as any).accountType).toBe(1)
    expect((wrapper.vm as any).botRole).toBe(2)

    await (wrapper.vm as any).updateRelayData()

    expect(mockSetRelayData).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          accountType: 1,
          botRole: 2,
        }),
      }),
    )

    expect(registerMonadIdentityCbor).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({
          accountType: 1,
          botRole: 2,
        }),
      }),
    )
  })
})
