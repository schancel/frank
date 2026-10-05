/** @jest-environment jsdom */
import { mount } from '@vue/test-utils'
import ProfileComponent from './Profile.vue'

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
        stubs: {
          'q-splitter': { template: '<div><slot name="before" /><slot name="after" /></div>' },
          'q-tabs': { template: '<div><slot /></div>' },
          'q-tab': { template: '<div />' },
          'q-tab-panels': { template: '<div><slot /></div>' },
          'q-tab-panel': { template: '<div><slot /></div>' },
          'q-input': { template: '<input />' },
          'q-toolbar': { template: '<div><slot /></div>' },
          'q-toolbar-title': { template: '<div><slot /></div>' },
          'q-file': { template: '<input type="file" />' },
          'q-btn': { template: '<button><slot /></button>' },
          'q-img': { template: '<img />' },
        },
      },
    })

    expect(wrapper.vm.$data.internalAvatar).toContain('data:image/webp;base64,RESIZED_AVATAR')
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
        stubs: {
          'q-splitter': { template: '<div><slot name="before" /><slot name="after" /></div>' },
          'q-tabs': { template: '<div><slot /></div>' },
          'q-tab': { template: '<div />' },
          'q-tab-panels': { template: '<div><slot /></div>' },
          'q-tab-panel': { template: '<div><slot /></div>' },
          'q-input': { template: '<input />' },
          'q-toolbar': { template: '<div><slot /></div>' },
          'q-toolbar-title': { template: '<div><slot /></div>' },
          'q-file': { template: '<input type="file" />' },
          'q-btn': { template: '<button><slot /></button>' },
          'q-img': { template: '<img />' },
        },
      },
    })

    ;(wrapper.vm as any).cycleAvatarRight()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.$data.internalAvatar).toContain('data:image/webp;base64,RESIZED_AVATAR')
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
        stubs: {
          'q-splitter': { template: '<div><slot name="before" /><slot name="after" /></div>' },
          'q-tabs': { template: '<div><slot /></div>' },
          'q-tab': { template: '<div />' },
          'q-tab-panels': { template: '<div><slot /></div>' },
          'q-tab-panel': { template: '<div><slot /></div>' },
          'q-input': { template: '<input />' },
          'q-toolbar': { template: '<div><slot /></div>' },
          'q-toolbar-title': { template: '<div><slot /></div>' },
          'q-file': { template: '<input type="file" />' },
          'q-btn': { template: '<button><slot /></button>' },
          'q-img': { template: '<img />' },
        },
      },
    })

    const blob = new Blob(['sample-avatar-bytes'], { type: 'image/jpeg' })
    const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' })

    await (wrapper.vm as any).$options.watch.avatarPath.call(wrapper.vm, file)
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.$data.internalAvatar).toContain('data:image/webp;base64,RESIZED_AVATAR')
    expect(wrapper.vm.$data.internalAvatar.length).toBeLessThanOrEqual(4096)
  })
})
