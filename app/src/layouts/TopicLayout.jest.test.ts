/** @jest-environment jsdom */
// TopicLayout is a caller of topics.putMessage too (#273 review F4): a burn that landed but could
// not be read back must clear the draft (resending would burn again); a failure before the burn
// keeps it for a retry.

import { shallowMount } from '@vue/test-utils'

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

beforeEach(() => jest.clearAllMocks())

describe('TopicLayout sendMessage', () => {
  it('burn landed but read-back failed: info notice, no error toast, draft cleared', async () => {
    mockPutMessage.mockRejectedValueOnce(
      new BurnRefreshError('post', new Error('read failed')),
    )
    const wrapper = mountLayout()

    await send(wrapper)

    expect(infoNotify).toHaveBeenCalledWith('POSTED_REFRESH_FAILED')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(draft(wrapper)).toBe('')
  })

  it('failure before the burn: error toast, draft kept so it can be retried', async () => {
    const failure = new Error('Nothing was sent')
    mockPutMessage.mockRejectedValueOnce(failure)
    const wrapper = mountLayout()

    await send(wrapper)

    expect(errorNotify).toHaveBeenCalledWith(failure)
    expect(infoNotify).not.toHaveBeenCalled()
    expect(draft(wrapper)).toBe('my draft')
  })

  it('success clears the draft and shows nothing', async () => {
    mockPutMessage.mockResolvedValueOnce(undefined)
    const wrapper = mountLayout()

    await send(wrapper)

    expect(draft(wrapper)).toBe('')
    expect(errorNotify).not.toHaveBeenCalled()
    expect(infoNotify).not.toHaveBeenCalled()
  })
})
