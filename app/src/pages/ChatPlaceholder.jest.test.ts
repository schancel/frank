/** @jest-environment jsdom */
import { shallowMount } from '@vue/test-utils'

jest.mock('src/components/chat/ChatList.vue', () => ({
  name: 'ChatList',
  template: '<div data-testid="chat-list-stub" />',
}))

import ChatPlaceholder from './ChatPlaceholder.vue'

function mountAt(width: number) {
  return shallowMount(ChatPlaceholder, {
    global: {
      mocks: { $t: (key: string) => key, $q: { screen: { width } } },
      stubs: {
        QPageContainer: { template: '<div><slot /></div>' },
        QPage: { template: '<main v-bind="$attrs"><slot /></main>' },
      },
    },
  })
}

it('on a phone /chat is the conversation list itself (the Messages tab)', () => {
  const wrapper = mountAt(375)
  expect(wrapper.find('[data-testid="chat-list-page"]').exists()).toBe(true)
  expect(wrapper.findComponent({ name: 'ChatList' }).exists()).toBe(true)
})

it('on a wide layout the list stays in the sidebar and the pane invites a pick', () => {
  const wrapper = mountAt(1280)
  expect(wrapper.find('[data-testid="chat-list-page"]').exists()).toBe(false)
  expect(wrapper.findComponent({ name: 'ChatList' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('chatList.selectChatOrAddContact')
})

it('the phone list page leaves the "Direct Messages" title to the layout header', () => {
  const wrapper = mountAt(375)
  const list = wrapper.findComponent({ name: 'ChatList' })
  expect(list.attributes('show-title')).toBe('false')
})
