/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import ProfileComponent from './Profile.vue'

const defaultStubs = {
  'q-splitter': {
    template: '<div><slot name="before" /><slot name="after" /></div>',
  },
  'q-tabs': { template: '<div><slot /></div>' },
  'q-tab': {
    props: ['name'],
    template: '<div :data-tab="name"><slot /></div>',
  },
  'q-tab-panels': {
    props: ['modelValue'],
    template: '<div data-test="tab-panels"><slot /></div>',
  },
  'q-tab-panel': {
    props: ['name'],
    template: '<div :data-panel="name"><slot /></div>',
  },
  'q-input': {
    props: ['modelValue'],
    template:
      '<div><input :value="modelValue" /><slot name="append" /><slot name="prepend" /></div>',
  },
  'q-toolbar': { template: '<div><slot /></div>' },
  'q-toolbar-title': { template: '<div><slot /></div>' },
  'q-file': { template: '<input type="file" />' },
  'q-btn': { template: '<button><slot /></button>' },
  'q-img': { template: '<img />' },
  'q-select': { template: '<div><slot /></div>' },
  'q-icon': { template: '<i />' },
  'q-card': { template: '<div><slot /></div>' },
  'q-skeleton': { template: '<div />' },
  'qrcode-vue': {
    props: ['value'],
    template: '<div data-test="mock-qrcode" :data-value="value" />',
  },
}

describe('Profile.vue component avatar handling', () => {
  let mockDrawImage: jest.Mock
  let originalImage: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockDrawImage = jest.fn()
    HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
      drawImage: mockDrawImage,
      fillRect: jest.fn(),
      fillStyle: '',
    })) as any
    HTMLCanvasElement.prototype.toDataURL = jest.fn((format = 'image/webp') => {
      return `data:${format};base64,RESIZED_AVATAR`
    })

    originalImage = window.Image
    class MockImage {
      crossOrigin = ''
      width = 512
      height = 512
      naturalWidth = 512
      naturalHeight = 512
      complete = true
      _src = ''
      onload: ((e: any) => void) | null = null
      get src() {
        return this._src
      }
      set src(val: string) {
        this._src = val
        if (this.onload) {
          this.onload({ target: this })
        }
      }
    }
    window.Image = MockImage as any
  })

  afterEach(() => {
    window.Image = originalImage
  })

  it('resizes default avatar on creation when no avatar is provided', async () => {
    const wrapper = mount(ProfileComponent, {
      props: {
        avatar: '',
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })

    expect(wrapper.vm.$data.internalAvatar).toContain(
      'data:image/webp;base64,RESIZED_AVATAR',
    )
    expect(wrapper.vm.$data.internalAvatar.length).toBeLessThanOrEqual(4096)
  })

  it('cycles avatar and downscales to thumbnail under 4 KB', async () => {
    const wrapper = mount(ProfileComponent, {
      props: {
        avatar: 'data:image/webp;base64,EXISTING',
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })

    ;(wrapper.vm as any).cycleAvatarRight()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.$data.internalAvatar).toContain(
      'data:image/webp;base64,RESIZED_AVATAR',
    )
    expect(wrapper.emitted('update:avatar')).toBeTruthy()
  })

  it('processes file upload, downscales and emits compressed data URL', async () => {
    const wrapper = mount(ProfileComponent, {
      props: {
        avatar: '',
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })

    const blob = new Blob(['sample-avatar-bytes'], { type: 'image/jpeg' })
    const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })

    await (wrapper.vm as any).$options.watch.avatarPath.call(wrapper.vm, file)
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.$data.internalAvatar).toContain(
      'data:image/webp;base64,RESIZED_AVATAR',
    )
    expect(wrapper.vm.$data.internalAvatar.length).toBeLessThanOrEqual(4096)
  })

  it('validates username handle and emits normalized handle', async () => {
    const wrapper = mount(ProfileComponent, {
      props: {
        username: 'alice',
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })

    // Username rule check
    expect((wrapper.vm as any).usernameRule('valid_user1')).toBe(true)
    expect((wrapper.vm as any).usernameRule('@valid_user1')).toBe(true)
    expect((wrapper.vm as any).usernameRule('ab')).toBe(
      'profile.invalidUsername',
    )
    expect((wrapper.vm as any).usernameRule('invalid user')).toBe(
      'profile.invalidUsername',
    )

    // Normalization and emit
    ;(wrapper.vm as any).internalUsername = '@Alice_99'
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:username')?.[0]).toEqual(['alice_99'])
  })

  it('manages interactive links list (add, remove, emit)', async () => {
    const wrapper = mount(ProfileComponent, {
      props: {
        links: [
          { type: 'website', url: 'https://example.com', label: 'My Site' },
        ],
      },
      global: {
        mocks: {
          $t: (key: string) => key,
        },
        stubs: defaultStubs,
      },
    })

    expect(wrapper.findAll('[data-test="profile-link-row"]').length).toBe(1)
    expect((wrapper.vm as any).internalLinks.length).toBe(1)

    // Click Add Link button adds row and emits update:links
    await wrapper.find('[data-test="profile-add-link"]').trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-test="profile-link-row"]').length).toBe(2)
    expect((wrapper.vm as any).internalLinks.length).toBe(2)
    expect((wrapper.vm as any).internalLinks[1]).toEqual({
      type: 'website',
      url: '',
      label: '',
    })
    expect(wrapper.emitted('update:links')).toBeTruthy()
    expect(wrapper.emitted('update:links')?.[0]).toEqual([
      [
        { type: 'website', url: 'https://example.com', label: 'My Site' },
        { type: 'website', url: '', label: '' },
      ],
    ])

    // Modify link
    ;(wrapper.vm as any).internalLinks[1].type = 'github'
    ;(wrapper.vm as any).internalLinks[1].url = 'https://github.com/alice'
    await wrapper.vm.$nextTick()
    expect(wrapper.emitted('update:links')).toBeTruthy()

    // Click remove link button on first link
    await wrapper
      .findAll('[data-test="profile-remove-link"]')[0]
      .trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.findAll('[data-test="profile-link-row"]').length).toBe(1)
    expect((wrapper.vm as any).internalLinks.length).toBe(1)
    expect((wrapper.vm as any).internalLinks[0].type).toBe('github')
  })

  describe('Identity & QR code tab', () => {
    it('renders identity tab and quick QR button', async () => {
      const wrapper = mount(ProfileComponent, {
        props: {
          name: 'Shammah',
          username: 'shammah',
          avatar: 'data:image/webp;base64,AVATAR',
          identityAddress: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
        },
        global: {
          mocks: {
            $t: (key: string) => key,
          },
          stubs: defaultStubs,
        },
      })

      expect(wrapper.find('[data-test="profile-tab-identity"]').exists()).toBe(
        true,
      )
      expect(
        wrapper.find('[data-test="profile-panel-identity"]').exists(),
      ).toBe(true)

      const quickBtn = wrapper.find('[data-test="profile-quick-qr-btn"]')
      expect(quickBtn.exists()).toBe(true)

      // Clicking quick QR button switches tab to identity
      await quickBtn.trigger('click')
      expect((wrapper.vm as any).tab).toBe('identity')

      // Identity panel contains QR code with the identity address
      const qr = wrapper.find('[data-test="profile-identity-qr"]')
      expect(qr.exists()).toBe(true)
      expect(qr.attributes('data-value')).toBe(
        '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
      )
    })
  })
})
