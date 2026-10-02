/** @jest-environment jsdom */
// TopicLayout is a caller of topics.putMessage too (#273 review F4): a burn that landed but could
// not be read back must clear the draft (resending would burn again); a failure before the burn
// keeps it for a retry.

import { flushPromises, shallowMount } from '@vue/test-utils'

import TopicLayout from './TopicLayout.vue'
import { BurnRefreshError } from 'src/utils/burn-refresh-error'
import { errorNotify, infoNotify } from 'src/utils/notifications'

const mockPutMessage = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({
    currentRoute: { value: { params: { topic: 'help' } } },
  }),
}))
jest.mock('src/stores/topics', () => ({
  useTopicStore: () => ({
    putMessage: (...args: unknown[]) => mockPutMessage(...args),
  }),
}))
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: async () => ({ identity: {} }),
}))
jest.mock('src/utils/notifications', () => ({
  errorNotify: jest.fn(),
  infoNotify: jest.fn(),
}))
jest.mock('src/components/topic/TopicInput.vue', () => ({
  name: 'TopicInput',
  props: ['message', 'disable'],
  template: '<div />',
}))
jest.mock('src/components/topic/TopicDrawer.vue', () => ({
  template: '<div />',
}))

const messages: Record<string, string> = {
  'stampPreparation.postedRefreshFailed': 'POSTED_REFRESH_FAILED',
}

function mountLayout() {
  const wrapper = shallowMount(TopicLayout, {
    global: {
      mocks: {
        $t: (key: string) => messages[key] ?? key,
        $status: { setup: true },
      },
    },
  })
  ;(wrapper.vm as unknown as { message: string }).message = 'my draft'
  return wrapper
}

const send = (w: ReturnType<typeof mountLayout>) =>
  (w.vm as unknown as { sendMessage(m: string): Promise<void> }).sendMessage(
    'my draft',
  )
const draft = (w: ReturnType<typeof mountLayout>) =>
  (w.vm as unknown as { message: string }).message
const inputDisable = (w: ReturnType<typeof mountLayout>) =>
  w.findComponent({ name: 'TopicInput' }).props('disable')

beforeEach(() => jest.clearAllMocks())

describe('TopicLayout sendMessage', () => {
  it('allows only one post in flight and exposes the busy state to TopicInput', async () => {
    let finish!: () => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve)),
    )
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as {
      sendMessage(m: string): Promise<void>
      sendingMessage: boolean
    }

    expect(inputDisable(wrapper)).toBe(false)
    expect(vm.sendingMessage).toBe(false)

    const first = vm.sendMessage('my draft')
    await flushPromises()
    expect(vm.sendingMessage).toBe(true)
    expect(draft(wrapper)).toBe('')
    expect(inputDisable(wrapper)).toBe(true)

    await vm.sendMessage('duplicate')
    expect(mockPutMessage).toHaveBeenCalledTimes(1)

    finish()
    await first
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('does not erase text edited while the submitted post is in flight', async () => {
    let finish!: () => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve)),
    )
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as {
      message: string
      sendMessage(m: string): Promise<void>
      sendingMessage: boolean
    }

    expect(inputDisable(wrapper)).toBe(false)
    const post = vm.sendMessage('my draft')
    await flushPromises()
    vm.message = 'newly typed text'
    finish()
    await post

    expect(vm.message).toBe('newly typed text')
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('restores a failed post without overwriting text entered in flight', async () => {
    let fail!: (error: Error) => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    )
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as {
      message: string
      sendMessage(m: string): Promise<void>
      sendingMessage: boolean
    }

    expect(inputDisable(wrapper)).toBe(false)
    const post = vm.sendMessage('my draft')
    await flushPromises()
    vm.message = 'next draft'
    fail(new Error('Nothing was sent'))
    await post

    expect(vm.message).toBe('my draft\nnext draft')
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('burn landed but read-back failed: info notice, no error toast, draft cleared', async () => {
    mockPutMessage.mockRejectedValueOnce(
      new BurnRefreshError('post', new Error('read failed')),
    )
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as { sendingMessage: boolean }

    expect(inputDisable(wrapper)).toBe(false)
    await send(wrapper)

    expect(infoNotify).toHaveBeenCalledWith('POSTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(draft(wrapper)).toBe('')
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('burn refresh failure does not overwrite text entered in flight', async () => {
    let fail!: (error: Error) => void
    mockPutMessage.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => (fail = reject)),
    )
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as {
      message: string
      sendMessage(m: string): Promise<void>
      sendingMessage: boolean
    }

    expect(inputDisable(wrapper)).toBe(false)
    const post = vm.sendMessage('my draft')
    await flushPromises()
    vm.message = 'next draft'
    fail(new BurnRefreshError('post', new Error('read failed')))
    await post

    expect(vm.message).toBe('next draft')
    expect(infoNotify).toHaveBeenCalledWith('POSTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('failure before the burn: error toast, draft kept so it can be retried', async () => {
    const failure = new Error('Nothing was sent')
    mockPutMessage.mockRejectedValueOnce(failure)
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as { sendingMessage: boolean }

    expect(inputDisable(wrapper)).toBe(false)
    await send(wrapper)

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(infoNotify).not.toHaveBeenCalled()
    expect(draft(wrapper)).toBe('my draft')
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })

  it('success clears the draft and shows nothing', async () => {
    mockPutMessage.mockResolvedValueOnce(undefined)
    const wrapper = mountLayout()
    const vm = wrapper.vm as unknown as { sendingMessage: boolean }

    expect(inputDisable(wrapper)).toBe(false)
    await send(wrapper)

    expect(draft(wrapper)).toBe('')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(infoNotify).not.toHaveBeenCalled()
    expect(vm.sendingMessage).toBe(false)
    expect(inputDisable(wrapper)).toBe(false)
  })
})
