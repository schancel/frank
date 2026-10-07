/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import EmailThreadView from './EmailThreadView.vue'
import type { ChatMessage, Conversation } from 'src/stores/chats'
import type { EmailItem } from '@frank/cashweb/types/messages'

describe('EmailThreadView', () => {
  const sampleEmail1: EmailItem = {
    type: 'email',
    messageId: '<msg1@example.com>',
    from: { address: 'alice@example.com', name: 'Alice Smith' },
    to: [{ address: 'me@frank.org', name: 'Me' }],
    subject: 'Project Kickoff',
    textBody: 'Hello, welcome to the project!',
  }

  const sampleEmail2: EmailItem = {
    type: 'email',
    messageId: '<msg2@example.com>',
    from: { address: 'bob@example.com', name: 'Bob Jones' },
    to: [
      { address: 'me@frank.org', name: 'Me' },
      { address: 'alice@example.com', name: 'Alice Smith' },
    ],
    cc: [{ address: 'carol@example.com', name: 'Carol Danvers' }],
    subject: 'Re: Project Kickoff',
    textBody: 'Sounds great, counting me in too.',
    inReplyTo: '<msg1@example.com>',
    attachments: [
      {
        filename: 'brief.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 2048,
      },
    ],
  }

  const messages: ChatMessage[] = [
    {
      outbound: false,
      status: 'confirmed',
      receivedTime: 1000,
      serverTime: 1000,
      items: [sampleEmail1],
      outpoints: [],
      senderAddress: '0x1111111111111111111111111111111111111111',
      payloadDigest: 'digest-msg1',
    },
    {
      outbound: false,
      status: 'confirmed',
      receivedTime: 2000,
      serverTime: 2000,
      items: [sampleEmail2],
      outpoints: [],
      senderAddress: '0x2222222222222222222222222222222222222222',
      payloadDigest: 'digest-msg2',
    },
  ]

  const conversation: Conversation = {
    id: 'conv-123',
    kind: 'email',
    name: 'Project Kickoff',
    address: '0xGateway',
    participants: ['0xGateway', '0xMe'],
    messages,
    totalUnreadMessages: 0,
    totalUnreadValue: 0,
    totalValue: 0,
    lastReceived: 2000,
    lastRead: 2000,
    stampAmount: 100,
  }

  function mountView(customProps = {}) {
    return shallowMount(EmailThreadView, {
      props: {
        conversation,
        messages,
        sending: false,
        recipientAddress: '0xGateway',
        ...customProps,
      },
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback || key,
          $q: { dark: { isActive: false } },
        },
        stubs: {
          'q-page': { template: '<div class="q-page"><slot /></div>' },
          'q-scroll-area': { template: '<div class="q-scroll-area"><slot /></div>' },
          'q-card': { template: '<div class="q-card"><slot /></div>' },
          'q-card-section': { template: '<div class="q-card-section"><slot /></div>' },
          'q-card-actions': { template: '<div class="q-card-actions"><slot /></div>' },
          'q-item': { template: '<div class="q-item" @click="$emit(\'click\')"><slot /></div>' },
          'q-item-section': { template: '<div class="q-item-section"><slot /></div>' },
          'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
          'q-badge': { template: '<span class="q-badge"><slot /></span>' },
          'q-btn': { template: '<button class="q-btn" @click="$emit(\'click\')"><slot /></button>' },
          'q-btn-toggle': { template: '<div class="q-btn-toggle" />' },
          'q-chip': { template: '<div class="q-chip"><slot /></div>' },
          'q-input': { template: '<input class="q-input" />' },
          'q-separator': { template: '<hr />' },
          'q-icon': { template: '<i class="q-icon" />' },
          'q-tooltip': { template: '<span class="q-tooltip"><slot /></span>' },
          'q-slide-transition': { template: '<div class="q-slide-transition"><slot /></div>' },
        },
      },
    })
  }

  it('renders thread subject and parses emails correctly', () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any

    expect(vm.threadSubject).toBe('Project Kickoff')
    expect(vm.parsedEmails.length).toBe(2)
    expect(vm.parsedEmails[0].fromAddress).toBe('alice@example.com')
    expect(vm.parsedEmails[1].fromAddress).toBe('bob@example.com')
  })

  it('defaults the latest email to expanded and earlier one to collapsed', () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any

    expect(vm.isExpanded('<msg1@example.com>')).toBe(false)
    expect(vm.isExpanded('<msg2@example.com>')).toBe(true)

    // Toggle expand
    vm.toggleExpand('<msg1@example.com>')
    expect(vm.isExpanded('<msg1@example.com>')).toBe(true)
  })

  it('defaults to Reply-All for multi-party email with correct To and Cc lists', () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any

    // msg2 has from: bob, to: [me, alice], cc: [carol] -> multi-party
    expect(vm.replyMode).toBe('reply_all')
    expect(vm.toList).toEqual(['bob@example.com'])
    expect(vm.ccList).toEqual(['me@frank.org', 'alice@example.com', 'carol@example.com'])
    expect(vm.subject).toBe('Re: Project Kickoff')
  })

  it('switches to single sender Reply mode when switched or invoked', () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any

    vm.prepareReply(vm.parsedEmails[0], 'reply')
    expect(vm.replyMode).toBe('reply')
    expect(vm.toList).toEqual(['alice@example.com'])
    expect(vm.ccList).toEqual([])
    expect(vm.subject).toBe('Re: Project Kickoff')
  })

  it('emits sendReply with constructed EmailItem and TextItem', async () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any

    vm.replyText = 'Thanks everyone, looks great!'
    expect(vm.canSend).toBe(true)

    vm.handleSend()

    expect(wrapper.emitted('sendReply')).toBeTruthy()
    const emittedCalls = wrapper.emitted('sendReply')!
    expect(emittedCalls.length).toBe(1)

    const payload = emittedCalls[0][0] as { items: any[]; fallbackText: string }
    expect(payload.items.length).toBe(2)

    const emailItem = payload.items.find(i => i.type === 'email')
    expect(emailItem).toBeDefined()
    expect(emailItem.to).toEqual([{ address: 'bob@example.com' }])
    expect(emailItem.textBody).toBe('Thanks everyone, looks great!')
    expect(emailItem.inReplyTo).toBe('<msg2@example.com>')

    const textItem = payload.items.find(i => i.type === 'text')
    expect(textItem).toBeDefined()
    expect(textItem.text).toContain('Thanks everyone, looks great!')

    // After send, reply text is cleared
    expect(vm.replyText).toBe('')
  })
})
