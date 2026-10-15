/** @jest-environment jsdom */

import { ref } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import EmailThreadView from './EmailThreadView.vue'
import type { ChatMessage, Conversation } from 'src/stores/chats'
import type { EmailItem } from '@frank/cashweb/types/messages'
import { useSettingsStore } from 'src/stores/settings'
import { useProfileStore } from 'src/stores/my-profile'
import { encodeEmailMessageItem } from '@frank/codec'
import type { EmailAttachment } from '@frank/codec'

const mockOwnAddress = ref<string | null>(
  '0x1111111111111111111111111111111111111111',
)
jest.mock('src/utils/own-address', () => {
  const actual = jest.requireActual('src/utils/own-address')
  return {
    ...actual,
    useReactiveOwnCanonicalAddress: () => mockOwnAddress,
    getOwnCanonicalAddress: async () => mockOwnAddress.value,
  }
})

describe('EmailThreadView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockOwnAddress.value = '0x1111111111111111111111111111111111111111'
    useSettingsStore().setEmailGatewayAddress(
      '0x3333333333333333333333333333333333333333',
    )
    useProfileStore().owner = '0x1111111111111111111111111111111111111111'
    useProfileStore().profile = { name: 'Me' }
  })
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
    address: '0x3333333333333333333333333333333333333333',
    participants: ['0x3333333333333333333333333333333333333333', '0xMe'],
    messages,
    totalUnreadMessages: 0,
    totalUnreadValue: 0,
    totalValue: 0,
    lastReceived: 2000,
    lastRead: 2000,
    stampAmount: 100,
    verifiedGateway: true,
  }

  function mountView(customProps = {}) {
    return shallowMount(EmailThreadView, {
      props: {
        conversation,
        messages,
        sending: false,
        recipientAddress: '0x3333333333333333333333333333333333333333',
        ...customProps,
      },
      global: {
        mocks: {
          $t: (key: string, fallback?: string) => fallback || key,
          $q: { dark: { isActive: false } },
        },
        stubs: {
          'q-page': { template: '<div class="q-page"><slot /></div>' },
          'q-scroll-area': {
            props: ['contentStyle', 'contentActiveStyle'],
            template: '<div class="q-scroll-area"><slot /></div>',
          },
          'q-banner': {
            template:
              '<div class="q-banner"><slot name="avatar" /><slot /></div>',
          },
          'q-card': { template: '<div class="q-card"><slot /></div>' },
          'q-card-section': {
            template: '<div class="q-card-section"><slot /></div>',
          },
          'q-card-actions': {
            template: '<div class="q-card-actions"><slot /></div>',
          },
          'q-item': {
            template:
              '<div class="q-item" @click="$emit(\'click\')"><slot /></div>',
          },
          'q-item-section': {
            template: '<div class="q-item-section"><slot /></div>',
          },
          'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
          'q-badge': { template: '<span class="q-badge"><slot /></span>' },
          'q-btn': {
            props: ['label'],
            emits: ['click'],
            template:
              '<button class="q-btn" @click="$emit(\'click\', $event)"><slot>{{ label }}</slot></button>',
          },
          'q-btn-toggle': { template: '<div class="q-btn-toggle" />' },
          'q-chip': { template: '<div class="q-chip"><slot /></div>' },
          'q-input': { template: '<input class="q-input" />' },
          'q-separator': { template: '<hr />' },
          'q-icon': { template: '<i class="q-icon" />' },
          'q-tooltip': { template: '<span class="q-tooltip"><slot /></span>' },
          'q-slide-transition': {
            template: '<div class="q-slide-transition"><slot /></div>',
          },
          'q-menu': { template: '<div class="q-menu"><slot /></div>' },
          'q-slider': { template: '<div class="q-slider" />' },
          'q-space': { template: '<div class="q-space" />' },
        },
      },
    })
  }

  const attachmentSizes: [number | undefined, string][] = [
    [undefined, '0 B'],
    [0, '0 B'],
    [2048, '2 KB'],
  ]
  it.each(attachmentSizes)(
    'preserves received attachment size display for %p bytes',
    (sizeBytes, expected) => {
      const attachment: EmailAttachment = {
        filename: 'size.txt',
        contentType: 'text/plain',
        ...(sizeBytes === undefined ? {} : { sizeBytes }),
      }
      const email: EmailItem = { ...sampleEmail2, attachments: [attachment] }
      const message: ChatMessage = { ...messages[1], items: [email] }
      const wrapper = mountView({
        messages: [message],
        conversation: { ...conversation, messages: [message] },
      })
      const chip = wrapper
        .findAll('.q-chip')
        .find(node => node.text().includes('size.txt'))
      expect(chip?.text()).toContain(`(${expected})`)
      wrapper.unmount()
    },
  )

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
    expect(vm.ccList).toEqual([
      'me@frank.org',
      'alice@example.com',
      'carol@example.com',
    ])
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

    await vm.handleSend()

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

  it('keeps the selected older RFC parent and participants when changing reply mode', async () => {
    const wrapper = mountView()
    const vm = wrapper.vm as any
    vm.prepareReply(vm.parsedEmails[0], 'reply')
    vm.onReplyModeChanged('reply_all')
    vm.replyText = 'Reply to the older card'
    await vm.handleSend()
    const payload = wrapper.emitted('sendReply')![0][0] as any
    expect(payload.items[0]).toMatchObject({
      inReplyTo: '<msg1@example.com>',
      references: ['<msg1@example.com>'],
      to: [{ address: 'alice@example.com' }],
    })
    expect(payload.conversationId).toBe(conversation.id)
  })

  it('never uses a plain card payload digest as an RFC parent', async () => {
    const wrapper = mountView({
      messages: [
        { ...messages[0], items: [{ type: 'text', text: 'plain note' }] },
      ],
    })
    const vm = wrapper.vm as any
    vm.prepareReply(vm.parsedEmails[0], 'reply')
    vm.replyText = 'Response'
    await vm.handleSend()
    const item = (wrapper.emitted('sendReply')![0][0] as any).items[0]
    expect(item.inReplyTo).toBeUndefined()
    expect(item.references).toBeUndefined()
  })

  describe('Peer Email Frame Defense & Trust Classification (ticket-unverified-peer-email-frames)', () => {
    const peerAddress = '0x2222222222222222222222222222222222222222'
    const peerEmailWithDkim: EmailItem = {
      type: 'email',
      messageId: '<spoofed@example.com>',
      from: { address: 'security@google.com', name: 'Google Security' },
      to: [{ address: 'me@frank.org' }],
      subject: 'Urgent Security Alert',
      textBody: 'Please send funds immediately',
      dkim: { verified: true } as any,
    }

    const peerMessage: ChatMessage = {
      outbound: false,
      status: 'confirmed',
      receivedTime: 3000,
      serverTime: 3000,
      items: [peerEmailWithDkim],
      outpoints: [],
      senderAddress: peerAddress,
      payloadDigest: 'digest-peer-email',
    }

    const unverifiedPeerConversation: Conversation = {
      id: 'conv-peer-email',
      kind: 'email',
      name: 'Urgent Security Alert',
      address: peerAddress,
      participants: [peerAddress, '0xMe'],
      messages: [peerMessage],
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 3000,
      lastRead: 3000,
      stampAmount: 100,
      verifiedGateway: false,
    }

    it('renders gateway badge and no warnings for verified gateway conversation', () => {
      const wrapper = mountView({
        conversation: { ...conversation, verifiedGateway: true },
      })
      const vm = wrapper.vm as any

      expect(vm.isVerifiedGateway).toBe(true)
      expect(wrapper.find('[data-testid="email-gateway-badge"]').exists()).toBe(
        true,
      )
      expect(
        wrapper.find('[data-testid="unverified-p2p-badge"]').exists(),
      ).toBe(false)
      expect(
        wrapper.find('[data-testid="unverified-peer-warning-banner"]').exists(),
      ).toBe(false)
      expect(
        wrapper.find('[data-testid="composer-unverified-warning"]').exists(),
      ).toBe(false)
      expect(vm.sendButtonLabel).toBe('Send')
    })

    it('displays prominent warning banner and unverified badge for peer-authored email frames', () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any

      expect(vm.isVerifiedGateway).toBe(false)
      // Gateway badge must be suppressed
      expect(wrapper.find('[data-testid="email-gateway-badge"]').exists()).toBe(
        false,
      )
      // Unverified badge must be shown
      const unverifiedBadge = wrapper.find(
        '[data-testid="unverified-p2p-badge"]',
      )
      expect(unverifiedBadge.exists()).toBe(true)
      expect(unverifiedBadge.text()).toContain(
        '⚠️ Direct P2P Email (Unverified)',
      )

      // Warning banner must be prominently shown with the exact required wording
      const banner = wrapper.find(
        '[data-testid="unverified-peer-warning-banner"]',
      )
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain(
        `⚠️ Direct Peer Email Frame: This message was sent directly by Frank user ${peerAddress} (not an Email Gateway). External email recipients will not receive replies.`,
      )
    })

    it('suppresses DKIM verified badge on peer-authored cards even if payload asserts DKIM', () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      expect(wrapper.find('[data-testid="dkim-badge"]').exists()).toBe(false)
    })

    it('guards composer replies: warns user and defaults to Frank P2P direct delivery', async () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any

      // Composer notice is visible
      const composerWarning = wrapper.find(
        '[data-testid="composer-unverified-warning"]',
      )
      expect(composerWarning.exists()).toBe(true)
      expect(composerWarning.text()).toContain('P2P Direct Reply')
      expect(composerWarning.text()).toContain(peerAddress)
      expect(composerWarning.text()).toContain(
        'External email recipients in To/Cc will not receive replies via MX.',
      )

      // Send button reflects P2P mode
      expect(vm.replyRouting).toBe('peer')
      expect(vm.sendButtonLabel).toBe('Send to Peer (P2P)')
      expect(vm.sendButtonTooltip).toContain(
        'Reply will only be delivered as a Frank direct message to the peer, not dispatched to external email addresses via MX',
      )

      // Sending in P2P mode
      vm.replyText = 'Thanks for your direct message.'
      await vm.handleSend()

      expect(wrapper.emitted('sendReply')).toBeTruthy()
      const emitted = wrapper.emitted('sendReply')![0][0] as {
        items: any[]
        fallbackText: string
        targetAddress?: string
      }
      expect(emitted.fallbackText).toContain(
        '[Direct P2P Email to ' + peerAddress,
      )
      expect(emitted.fallbackText).toContain(
        '(external email recipients not notified)',
      )
      expect(emitted.targetAddress).toBeUndefined()
    })

    it('allows routing through gateway if user chooses to bridge via gateway', async () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any

      // Switch routing to gateway
      vm.replyRouting = 'gateway'
      expect(vm.sendButtonLabel).toBe('Bridge via Gateway')
      expect(vm.sendButtonTooltip).toContain(
        'Route through Frank Email Gateway',
      )

      vm.replyText = 'Sending via gateway instead.'
      await vm.handleSend()

      const emitted = wrapper.emitted('sendReply')![0][0] as {
        items: any[]
        fallbackText: string
        targetAddress?: string
      }
      expect(emitted.fallbackText).toContain('[Email to ')
      expect(emitted.targetAddress).toBe(
        '0x3333333333333333333333333333333333333333',
      )
    })

    it('does not send an old gateway thread after the relay identity changes', async () => {
      const wrapper = mountView()
      const vm = wrapper.vm as any
      vm.replyText = 'Do not send to the old address'
      useSettingsStore().resetEmailGatewayAddress()
      await wrapper.vm.$nextTick()
      expect(vm.canSend).toBe(false)
      await vm.handleSend()
      expect(wrapper.emitted('sendReply')).toBeUndefined()
    })

    it('does not bridge a peer email when this relay has no gateway', async () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any
      vm.replyRouting = 'gateway'
      vm.replyText = 'Cannot bridge'
      useSettingsStore().resetEmailGatewayAddress()
      await wrapper.vm.$nextTick()
      expect(vm.canSend).toBe(false)
      await vm.handleSend()
      expect(wrapper.emitted('sendReply')).toBeUndefined()
    })

    it('initializes in draft mode with prefilled recipient when messages are empty (0-message state)', () => {
      const draftConversation: Conversation = {
        ...conversation,
        name: 'charlie@example.com',
        topic: 'charlie@example.com',
        emailRecipient: 'charlie@example.com',
        messages: [],
      }
      const wrapper = mountView({
        conversation: draftConversation,
        messages: [],
      })
      const vm = wrapper.vm as any

      expect(vm.isDraft).toBe(true)
      expect(
        wrapper.find('[data-testid="email-draft-placeholder"]').exists(),
      ).toBe(true)
      expect(vm.toList).toEqual(['charlie@example.com'])
      expect(vm.replyMode).toBe('reply')
    })

    it('sends newly composed email draft without inReplyTo', async () => {
      const draftConversation: Conversation = {
        ...conversation,
        name: 'charlie@example.com',
        topic: 'charlie@example.com',
        emailRecipient: 'charlie@example.com',
        messages: [],
      }
      const wrapper = mountView({
        conversation: draftConversation,
        messages: [],
      })
      const vm = wrapper.vm as any

      expect(vm.isDraft).toBe(true)
      vm.subject = 'Meeting Tomorrow'
      vm.replyText = 'Hi Charlie, let us meet tomorrow at 10am.'
      expect(vm.canSend).toBe(true)

      await vm.handleSend()

      expect(wrapper.emitted('sendReply')).toBeTruthy()
      const emittedCalls = wrapper.emitted('sendReply')!
      expect(emittedCalls.length).toBe(1)

      const payload = emittedCalls[0][0] as {
        items: any[]
        fallbackText: string
      }
      expect(payload.items.length).toBe(2)

      const emailItem = payload.items.find(i => i.type === 'email')
      expect(emailItem).toBeDefined()
      expect(emailItem.to).toEqual([{ address: 'charlie@example.com' }])
      expect(emailItem.subject).toBe('Meeting Tomorrow')
      expect(emailItem.textBody).toBe(
        'Hi Charlie, let us meet tomorrow at 10am.',
      )
      expect(emailItem.inReplyTo).toBeUndefined()

      const textItem = payload.items.find(i => i.type === 'text')
      expect(textItem).toBeDefined()
      expect(textItem.text).toContain('Meeting Tomorrow')
      expect(textItem.text).toContain(
        'Hi Charlie, let us meet tomorrow at 10am.',
      )
    })

    describe('Outbound Attachments in Composer', () => {
      it('renders attach file button and hidden file input', () => {
        const wrapper = mountView()
        const attachBtn = wrapper.find('[data-testid="attach-file-btn"]')
        expect(attachBtn.exists()).toBe(true)

        const fileInput = wrapper.find('input[type="file"]')
        expect(fileInput.exists()).toBe(true)
        expect(fileInput.attributes('style')).toContain('display: none')
      })

      it('stages selected files and displays chip with formatted file size and remove button', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        // Initially no staged files
        expect(
          wrapper.find('[data-testid="staged-attachments-container"]').exists(),
        ).toBe(false)

        // Simulate file selection
        const fakeFile1 = new File(['file contents 1'], 'test-document.pdf', {
          type: 'application/pdf',
        })
        Object.defineProperty(fakeFile1, 'size', { value: 24576 }) // 24 KB

        const fakeFile2 = new File(['image data'], 'avatar.png', {
          type: 'image/png',
        })
        Object.defineProperty(fakeFile2, 'size', { value: 1048576 }) // 1 MB

        vm.handleFilesSelected({
          target: { files: [fakeFile1, fakeFile2], value: 'fake-path' },
        })
        await wrapper.vm.$nextTick()

        expect(vm.stagedFiles.length).toBe(2)
        const container = wrapper.find(
          '[data-testid="staged-attachments-container"]',
        )
        expect(container.exists()).toBe(true)

        const chips = wrapper.findAll('.staged-attachment-chip')
        expect(chips.length).toBe(2)
        expect(chips[0].text()).toContain('test-document.pdf')
        expect(chips[0].text()).toContain('24 KB')
        expect(chips[1].text()).toContain('avatar.png')
        expect(chips[1].text()).toContain('1 MB')

        // Remove the first attachment via remove button
        const removeButtons = wrapper.findAll(
          '[data-testid="remove-attachment-btn"]',
        )
        expect(removeButtons.length).toBe(2)
        await removeButtons[0].trigger('click')

        expect(vm.stagedFiles.length).toBe(1)
        expect(vm.stagedFiles[0].name).toBe('avatar.png')
      })

      it('encodes staged files into attachments on emitted EmailItem and clears staged files after send', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        const fileContent = 'Hello Frank email attachments'
        const fakeFile = new File([fileContent], 'notes.txt', {
          type: 'text/plain',
        })
        Object.defineProperty(fakeFile, 'size', { value: fileContent.length })

        vm.stagedFiles = [fakeFile]
        vm.replyText = 'Please see the attached notes.'

        jest
          .spyOn(vm, 'readFileAsBase64')
          .mockResolvedValue('data:text/plain;base64,SGVsbG8=')

        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const emitted = wrapper.emitted('sendReply')![0][0] as {
          items: any[]
          fallbackText: string
        }
        const emailItem = emitted.items.find(i => i.type === 'email')
        expect(emailItem).toBeDefined()
        expect(emailItem.attachments).toBeDefined()
        expect(emailItem.attachments.length).toBe(1)
        expect(emailItem.attachments[0]).toEqual({
          filename: 'notes.txt',
          contentType: 'text/plain',
          size: fileContent.length,
          sizeBytes: fileContent.length,
          dataBase64: 'data:text/plain;base64,SGVsbG8=',
        })

        // Staged files should be cleared after send
        expect(vm.stagedFiles.length).toBe(0)
        expect(vm.replyText).toBe('')
      })
    })

    describe('Sandboxed HTML Email Rendering', () => {
      it('shows toggle button when email has htmlBody and toggles between plain text and sandboxed iframe', async () => {
        const emailWithHtml: EmailItem = {
          type: 'email',
          messageId: '<html-msg@example.com>',
          from: { address: 'newsletter@example.com', name: 'Newsletter' },
          to: [{ address: 'me@frank.org' }],
          subject: 'Weekly Digest',
          textBody: 'Plain text version of weekly digest.',
          htmlBody:
            '<h1>Weekly Digest</h1><p>Welcome to <b>Frank</b>!</p><script>alert("evil")</script>',
        }

        const msgWithHtml: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 5000,
          serverTime: 5000,
          items: [emailWithHtml],
          outpoints: [],
          senderAddress: '0x3333333333333333333333333333333333333333',
          payloadDigest: 'digest-html-msg',
        }

        const wrapper = mountView({
          messages: [msgWithHtml],
        })
        const vm = wrapper.vm as any

        expect(vm.isExpanded('<html-msg@example.com>')).toBe(true)

        // Toggle button should be visible with "Show HTML"
        const toggleBtn = wrapper.find('[data-testid="toggle-html-view"]')
        expect(toggleBtn.exists()).toBe(true)
        expect(toggleBtn.text()).toContain('Show HTML')

        // Plain text should be displayed initially, no iframe
        expect(wrapper.find('iframe.email-html-frame').exists()).toBe(false)
        expect(wrapper.find('.email-body-text').text()).toContain(
          'Plain text version of weekly digest.',
        )

        // Click toggle to switch to HTML view
        await toggleBtn.trigger('click')
        expect(toggleBtn.text()).toContain('Show Plain Text')

        // Sandboxed iframe should now be rendered
        const iframe = wrapper.find('iframe.email-html-frame')
        expect(iframe.exists()).toBe(true)
        expect(iframe.attributes('sandbox')).toBe('allow-same-origin')

        // srcdoc should contain sanitized HTML (script tag stripped by DOMPurify)
        const srcdoc = iframe.attributes('srcdoc')
        expect(srcdoc).toContain('<h1>Weekly Digest</h1>')
        expect(srcdoc).toContain('<b>Frank</b>')
        expect(srcdoc).not.toContain('<script>')
        expect(srcdoc).not.toContain('alert("evil")')

        // Click toggle again to switch back to plain text
        await toggleBtn.trigger('click')
        expect(toggleBtn.text()).toContain('Show HTML')
        expect(wrapper.find('iframe.email-html-frame').exists()).toBe(false)
        expect(wrapper.find('.email-body-text').exists()).toBe(true)
      })
    })

    describe('Configurable Email Gateway Integration', () => {
      it('reads emailGatewayAddress from settingsStore and uses it when bridging via gateway', async () => {
        const settingsStore = useSettingsStore()
        const customGateway = '0x8888888888888888888888888888888888888888'
        settingsStore.setEmailGatewayAddress(customGateway)

        const wrapper = mountView({
          conversation: unverifiedPeerConversation,
          messages: [peerMessage],
          recipientAddress: peerAddress,
        })
        const vm = wrapper.vm as any

        expect(vm.emailGatewayAddress).toBe(customGateway)

        // Route through gateway
        vm.replyRouting = 'gateway'
        vm.replyText = 'Routing to custom gateway'
        await vm.handleSend()

        const emitted = wrapper.emitted('sendReply')![0][0] as {
          targetAddress?: string
        }
        expect(emitted.targetAddress).toBe(customGateway)
      })
    })

    describe('Outbound Email Follow-up & Recipient Hygiene', () => {
      it('populates external recipient instead of me when latest email is outbound, and hides reply-all toggle', () => {
        const outboundMsg: ChatMessage = {
          outbound: true,
          status: 'confirmed',
          receivedTime: 5000,
          serverTime: 5000,
          items: [
            {
              type: 'email',
              messageId: '<outbound-msg-1@frank.org>',
              from: {
                address: '0x1111111111111111111111111111111111111111',
                name: 'Me',
              },
              to: [{ address: 'shammah.chancellor@gmail.com' }],
              subject: 'Initial Outbound Email',
              textBody: 'Hello external world!',
            },
          ],
          outpoints: [],
          senderAddress: '0x1111111111111111111111111111111111111111',
          payloadDigest: 'digest-outbound-1',
        }
        const outboundConv: Conversation = {
          id: 'conv-outbound-email',
          kind: 'email',
          name: 'Initial Outbound Email',
          address: '0x1111111111111111111111111111111111111111',
          participants: ['0x1111111111111111111111111111111111111111'],
          messages: [outboundMsg],
          totalUnreadMessages: 0,
          totalUnreadValue: 0,
          totalValue: 0,
          lastReceived: 5000,
          lastRead: 5000,
          verifiedGateway: true,
        }

        const wrapper = mountView({
          conversation: outboundConv,
          messages: [outboundMsg],
        })
        const vm = wrapper.vm as any

        // Must populate the external recipient, NOT 'me'
        expect(vm.toList).toEqual(['shammah.chancellor@gmail.com'])
        expect(vm.toList).not.toContain('me')
        expect(vm.ccList).toEqual([])

        // Must hide reply-all toggle because this is an outbound follow-up
        expect(vm.isOutboundFollowUp).toBe(true)
        expect(vm.showReplyModeToggle).toBe(false)
        expect(vm.canReplyAll(vm.parsedEmails[0])).toBe(false)

        // allParticipants must contain external recipient, never 'me'
        expect(vm.allParticipants).toContain('shammah.chancellor@gmail.com')
        expect(vm.allParticipants).not.toContain('me')
      })

      it('rejects adding awkward me tag as recipient in To, Cc, and Bcc fields', () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        vm.newToInput = 'me'
        vm.addToRecipient()
        expect(vm.toList).not.toContain('me')

        vm.newCcInput = 'ME'
        vm.addCcRecipient()
        expect(vm.ccList).not.toContain('ME')

        vm.newBccInput = 'me'
        vm.addBccRecipient()
        expect(vm.bccList).not.toContain('me')

        // Valid addresses are accepted
        vm.newToInput = 'valid.user@example.com'
        vm.addToRecipient()
        expect(vm.toList).toContain('valid.user@example.com')
      })

      it('cleans fallback card textBody and snippet from wire headers', () => {
        const fallbackMsg: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 6000,
          serverTime: 6000,
          items: [
            {
              type: 'text',
              text: '[Direct P2P Email to 0x1111111111111111111111111111111111111111 (external email recipients not notified)]\nSubject: Fallback Notice\n\nClean body content.',
            },
          ],
          outpoints: [],
          senderAddress: '0x1111111111111111111111111111111111111111',
          payloadDigest: 'digest-fallback-1',
        }
        const wrapper = mountView({
          conversation: {
            id: 'conv-fallback',
            kind: 'email',
            name: 'Fallback Notice',
            address: '0x1111111111111111111111111111111111111111',
            participants: ['0x1111111111111111111111111111111111111111'],
            messages: [fallbackMsg],
            totalUnreadMessages: 0,
            totalUnreadValue: 0,
            totalValue: 0,
            lastReceived: 6000,
            lastRead: 6000,
            verifiedGateway: false,
          },
          messages: [fallbackMsg],
        })
        const vm = wrapper.vm as any
        const card = vm.parsedEmails[0]

        expect(card.textBody).toBe('Clean body content.')
        expect(card.snippet).toBe('Clean body content.')
        expect(card.snippet).not.toContain('[Direct P2P Email')
      })
    })

    describe('Email Stamp Fee and Multiplier Controls', () => {
      it('renders email stamp button with default pill text and fee in tooltip', () => {
        const wrapper = mountView({
          stampAmount: '0.01',
          defaultStampWei: 10000000000000000n,
          defaultStampMode: true,
        })
        const stampBtn = wrapper.find('[data-testid="email-stamp-btn"]')
        expect(stampBtn.exists()).toBe(true)
        const vm = wrapper.vm as any
        expect(vm.stampPillText).toBeDefined()
        expect(vm.sendButtonTooltip).toContain('[Fee:')
      })

      it('displays multiplier badge when stamp is higher than default', () => {
        const wrapper = mountView({
          stampAmount: '0.02',
          defaultStampWei: 10000000000000000n,
          defaultStampMode: false,
        })
        const vm = wrapper.vm as any
        expect(vm.stampMultiplier).toBe('2')
        expect(vm.isDefaultStamp).toBe(false)
      })

      it('emits update:stampAmount with 0 when Free button is clicked', async () => {
        const wrapper = mountView({
          stampAmount: '0.01',
        })
        const vm = wrapper.vm as any
        vm.chooseFreeStamp()
        expect(wrapper.emitted('update:stampAmount')?.[0]).toEqual(['0'])
      })

      it('emits resetStampDefault when resetToDefaultStamp is called', () => {
        const wrapper = mountView({
          stampAmount: '0.05',
          defaultStampMode: false,
        })
        const vm = wrapper.vm as any
        vm.resetToDefaultStamp()
        expect(wrapper.emitted('resetStampDefault')).toBeTruthy()
      })
    })

    describe('Email Card Collapse Animation & Layout Hygiene', () => {
      it('never applies transition-generic to email cards', () => {
        const wrapper = mountView()
        const cards = wrapper.findAll('.email-card')
        expect(cards.length).toBeGreaterThan(0)
        for (const card of cards) {
          expect(card.classes()).not.toContain('transition-generic')
        }
      })

      it('toggles expansion state cleanly on collapse without mutation loops', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any
        const latestId = '<msg2@example.com>'
        expect(vm.isExpanded(latestId)).toBe(true)

        // Collapse latest
        vm.toggleExpand(latestId)
        expect(vm.isExpanded(latestId)).toBe(false)

        // Expand again
        vm.toggleExpand(latestId)
        expect(vm.isExpanded(latestId)).toBe(true)
      })

      it('toggles all expanded state correctly', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        // Expand all
        vm.toggleAllExpanded()
        expect(vm.allExpanded).toBe(true)
        expect(vm.isExpanded('<msg1@example.com>')).toBe(true)
        expect(vm.isExpanded('<msg2@example.com>')).toBe(true)

        // Collapse all
        vm.toggleAllExpanded()
        expect(vm.allExpanded).toBe(false)
        expect(vm.isExpanded('<msg1@example.com>')).toBe(false)
        expect(vm.isExpanded('<msg2@example.com>')).toBe(false)
      })

      it('produces deterministic timestamps when serverTime and receivedTime are missing', () => {
        const messageWithoutTimes: ChatMessage = {
          outbound: true,
          status: 'pending',
          receivedTime: 0,
          serverTime: 0,
          localTime: 1234567,
          items: [sampleEmail1],
          outpoints: [],
          senderAddress: '0x1111111111111111111111111111111111111111',
          payloadDigest: 'digest-no-time',
        } as any

        const wrapper = mountView({
          messages: [messageWithoutTimes],
        })
        const vm = wrapper.vm as any
        const cardsFirst = vm.parsedEmails
        expect(cardsFirst[0].timestamp).toBe(1234567)

        const cardsSecond = vm.parsedEmails
        expect(cardsSecond[0].timestamp).toBe(1234567)
      })

      it('breaks cyclic computed dependency between threadSubject and parsedEmails', () => {
        const fallbackMsg: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 1500,
          serverTime: 1500,
          items: [{ type: 'text', text: 'plain update' }],
          outpoints: [],
          senderAddress: '0x1111111111111111111111111111111111111111',
          payloadDigest: 'digest-fallback-msg',
        }

        const wrapper = mountView({
          conversation: { ...conversation, name: 'Subject From Conv' },
          messages: [fallbackMsg],
        })
        const vm = wrapper.vm as any

        expect(vm.threadSubject).toBe('Subject From Conv')
        expect(vm.parsedEmails.length).toBe(1)
        expect(vm.parsedEmails[0].subject).toBe('Subject From Conv')
      })

      it('returns 100% height from pageStyleFn to fit container without pixel oscillations', () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any
        const style = vm.pageStyleFn(64, 800)
        expect(style).toEqual({
          height: '100%',
          maxHeight: '100%',
        })
      })

      it('places attachment button, stamp price pill, and send button in the top composer header bar', () => {
        const wrapper = mountView()
        const headerBar = wrapper.find('.composer-header-bar')
        expect(headerBar.exists()).toBe(true)
        expect(headerBar.find('[data-testid="attach-file-btn"]').exists()).toBe(
          true,
        )
        expect(headerBar.find('[data-testid="email-stamp-btn"]').exists()).toBe(
          true,
        )
        expect(headerBar.find('[data-testid="send-email-btn"]').exists()).toBe(
          true,
        )
      })

      it('renders multi-line reply textarea without autogrow to prevent Enter key ResizeObserver bounce', () => {
        const replyWrapper = mountView()
        const replyTextarea = replyWrapper.find('.email-textarea')
        expect(replyTextarea.exists()).toBe(true)
        expect(replyTextarea.attributes('autogrow')).toBeUndefined()
        expect(replyTextarea.attributes('rows')).toBe('4')

        const draftWrapper = mountView({
          conversation: {
            ...conversation,
            messages: [],
          },
          messages: [],
        })
        const draftTextarea = draftWrapper.find('.email-textarea')
        expect(draftTextarea.exists()).toBe(true)
        expect(draftTextarea.attributes('autogrow')).toBeUndefined()
        expect(draftTextarea.attributes('rows')).toBe('6')
      })
    })

    describe('Email Party Address & Encoding Validation', () => {
      it('successfully encodes outbound emailItem with encodeEmailMessageItem without throwing', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        vm.replyText = 'Testing CDDL stage 8.2 email party address compliance.'
        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as {
          items: any[]
          fallbackText: string
        }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem).toBeDefined()

        // From party address must be 3..320 chars, never 'me'
        expect(emailItem.from.address).not.toBe('me')
        expect(emailItem.from.address.length).toBeGreaterThanOrEqual(3)
        expect(emailItem.from.address.length).toBeLessThanOrEqual(320)
        expect(emailItem.from.address).toContain('@signet.mx')
        expect(emailItem.from.name).toBe('Me')

        // To party address must be valid
        expect(emailItem.to[0].address).toBe('bob@example.com')

        // Validated by @frank/codec encodeEmailMessageItem without throwing
        expect(() => {
          const frameBytes = encodeEmailMessageItem(emailItem)
          expect(frameBytes).toBeInstanceOf(Uint8Array)
          expect(frameBytes.length).toBeGreaterThan(0)
        }).not.toThrow()
      })

      it('formats from party address for direct P2P routing and passes encodeEmailMessageItem', async () => {
        const wrapper = mountView({
          conversation: unverifiedPeerConversation,
          messages: [peerMessage],
          recipientAddress: peerAddress,
        })
        const vm = wrapper.vm as any

        vm.replyRouting = 'peer'
        vm.replyText = 'Direct peer email reply'
        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as { items: any[] }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem).toBeDefined()
        expect(emailItem.from.address).toBe(
          '0x1111111111111111111111111111111111111111',
        )
        expect(emailItem.from.name).toBe('Me')

        expect(() => {
          const frameBytes = encodeEmailMessageItem(emailItem)
          expect(frameBytes).toBeInstanceOf(Uint8Array)
          expect(frameBytes.length).toBeGreaterThan(0)
        }).not.toThrow()
      })

      it('sanitizes me and invalid addresses out of toList, ccList, and bccList on send', async () => {
        const wrapper = mountView()
        const vm = wrapper.vm as any

        vm.toList = ['me', 'valid@example.com', 'x']
        vm.ccList = ['me', 'valid.cc@example.com']
        vm.bccList = ['me', 'valid.bcc@example.com']
        vm.replyText = 'Hello with cleaned recipients'

        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as { items: any[] }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem).toBeDefined()
        expect(emailItem.to).toEqual([{ address: 'valid@example.com' }])
        expect(emailItem.cc).toEqual([{ address: 'valid.cc@example.com' }])
        expect(emailItem.bcc).toEqual([{ address: 'valid.bcc@example.com' }])

        expect(() => encodeEmailMessageItem(emailItem)).not.toThrow()
      })

      it('falls back to conversation.emailRecipient if toList only had me', async () => {
        const wrapper = mountView({
          conversation: {
            ...conversation,
            emailRecipient: 'fallback.recipient@example.com',
          },
        })
        const vm = wrapper.vm as any

        vm.toList = ['me']
        vm.replyText = 'Testing fallback'

        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as { items: any[] }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem).toBeDefined()
        expect(emailItem.to).toEqual([
          { address: 'fallback.recipient@example.com' },
        ])

        expect(() => encodeEmailMessageItem(emailItem)).not.toThrow()
      })

      it('aborts send if toList has no valid recipients and fallback is empty', async () => {
        const wrapper = mountView({
          conversation: {
            ...conversation,
            emailRecipient: undefined,
          },
        })
        const vm = wrapper.vm as any

        vm.toList = ['me']
        vm.replyText = 'Testing abort'

        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeUndefined()
      })
    })

    describe('Participant Deduplication & Gateway Reply-Alias Canonicalization', () => {
      it('deduplicates bare email and display-name email into a single named participant entry', () => {
        const msg1: ChatMessage = {
          outbound: true,
          status: 'confirmed',
          receivedTime: 1000,
          serverTime: 1000,
          items: [
            {
              type: 'email',
              messageId: '<msg-out-1@signet.mx>',
              from: {
                address: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
                name: 'Shammah',
              },
              to: [{ address: 'shammah.chancellor@gmail.com' }],
              subject: 'Hello',
              textBody: 'Initial outbound email',
            },
          ],
          outpoints: [],
          senderAddress: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
          payloadDigest: 'digest-dedup-1',
        }
        const msg2: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 2000,
          serverTime: 2000,
          items: [
            {
              type: 'email',
              messageId: '<msg-in-2@gmail.com>',
              from: {
                address: 'shammah.chancellor@gmail.com',
                name: 'Shammah Chancellor',
              },
              to: [
                {
                  address:
                    '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
                  name: 'Shammah',
                },
              ],
              subject: 'Re: Hello',
              textBody: 'Reply with display name',
            },
          ],
          outpoints: [],
          senderAddress: '0x3333333333333333333333333333333333333333',
          payloadDigest: 'digest-dedup-2',
        }

        const wrapper = mountView({
          messages: [msg1, msg2],
        })
        const vm = wrapper.vm as any

        expect(vm.allParticipants).toEqual([
          'Shammah <0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx>',
          'Shammah Chancellor <shammah.chancellor@gmail.com>',
        ])
      })

      it('folds gateway reply alias m<30-hex>@signet.mx and own 0x...@signet.mx address into a single self participant entry', () => {
        mockOwnAddress.value = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        useProfileStore().owner = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        useProfileStore().profile = { name: 'Shammah' }

        const msg1: ChatMessage = {
          outbound: true,
          status: 'confirmed',
          receivedTime: 1000,
          serverTime: 1000,
          items: [
            {
              type: 'email',
              messageId: '<msg-out-alias-1@signet.mx>',
              from: {
                address: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
                name: 'Shammah',
              },
              to: [{ address: 'shammah.chancellor@gmail.com' }],
              subject: 'Alias test',
              textBody: 'Outbound message',
            },
          ],
          outpoints: [],
          senderAddress: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3',
          payloadDigest: 'digest-alias-1',
        }
        const msg2: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 2000,
          serverTime: 2000,
          items: [
            {
              type: 'email',
              messageId: '<msg-in-alias-2@gmail.com>',
              from: {
                address: 'shammah.chancellor@gmail.com',
                name: 'Shammah Chancellor',
              },
              to: [{ address: 'm51131cde71c27c8384626d7aa72898@signet.mx' }],
              subject: 'Re: Alias test',
              textBody: 'Inbound reply to gateway alias',
            },
          ],
          outpoints: [],
          senderAddress: '0x3333333333333333333333333333333333333333',
          payloadDigest: 'digest-alias-2',
        }

        const wrapper = mountView({
          messages: [msg1, msg2],
        })
        const vm = wrapper.vm as any

        expect(vm.allParticipants).toEqual([
          'Shammah <0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx>',
          'Shammah Chancellor <shammah.chancellor@gmail.com>',
        ])
        expect(vm.allParticipants).not.toContain(
          'm51131cde71c27c8384626d7aa72898@signet.mx',
        )
      })

      it('excludes own m<30-hex>@signet.mx reply alias and own address from ccList in reply_all', () => {
        mockOwnAddress.value = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        useProfileStore().owner = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        useProfileStore().profile = { name: 'Shammah' }

        const inboundMultiParty: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 3000,
          serverTime: 3000,
          items: [
            {
              type: 'email',
              messageId: '<msg-in-replyall@gmail.com>',
              from: {
                address: 'shammah.chancellor@gmail.com',
                name: 'Shammah Chancellor',
              },
              to: [
                { address: 'm51131cde71c27c8384626d7aa72898@signet.mx' },
                {
                  address:
                    '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
                  name: 'Shammah',
                },
                { address: 'colleague@example.com', name: 'Colleague' },
              ],
              cc: [
                { address: 'Colleague@example.com' },
                { address: 'team@example.com' },
              ],
              subject: 'Re: Thread with Alias',
              textBody: 'Replying to everyone',
            },
          ],
          outpoints: [],
          senderAddress: '0x3333333333333333333333333333333333333333',
          payloadDigest: 'digest-replyall-alias',
        }

        const wrapper = mountView({
          messages: [inboundMultiParty],
        })
        const vm = wrapper.vm as any

        expect(vm.replyMode).toBe('reply_all')
        expect(vm.toList).toEqual(['shammah.chancellor@gmail.com'])
        expect(vm.ccList).toEqual(['colleague@example.com', 'team@example.com'])
        expect(vm.ccList).not.toContain(
          'm51131cde71c27c8384626d7aa72898@signet.mx',
        )
        expect(vm.ccList).not.toContain(
          '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
        )
      })

      it('allows participant list to wrap cleanly without ellipsis or no-wrap blowout', () => {
        const wrapper = mountView()
        const participantList = wrapper.find('.participant-list')
        expect(participantList.exists()).toBe(true)
        expect(participantList.classes()).not.toContain('ellipsis')

        const participantRow = wrapper.find('.participant-row')
        expect(participantRow.exists()).toBe(true)
        expect(participantRow.classes()).not.toContain('ellipsis')
        expect(participantRow.classes()).not.toContain('no-wrap')
      })

      it('decodes quoted-printable UTF-8 sequences like =E2=80=AF and soft line breaks in email bodies', () => {
        const qpMessage: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 4000,
          serverTime: 4000,
          items: [
            {
              type: 'email',
              messageId: '<msg-qp-1@gmail.com>',
              from: {
                address: 'shammah.chancellor@gmail.com',
                name: 'Shammah Chancellor',
              },
              to: [{ address: 'm51131cde71c27c8384626d7aa72898@signet.mx' }],
              subject: 'Re: Test Email',
              textBody:
                'Sounds good!\r\n\r\nOn Tue, Oct 13, 2026 at 10:00=E2=80=AFAM Shammah <=\r\n0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx> wrote:\r\n> Test body',
            },
          ],
          outpoints: [],
          senderAddress: '0x3333333333333333333333333333333333333333',
          payloadDigest: 'digest-qp-1',
        }

        const wrapper = mountView({
          messages: [qpMessage],
        })
        const vm = wrapper.vm as any
        const card = vm.parsedEmails[0]

        expect(card.textBody).not.toContain('=E2=80=AF')
        expect(card.textBody).toContain('10:00\u202FAM')
        expect(card.mainBody).toBe('Sounds good!')
        expect(card.quotedBody).toContain(
          'On Tue, Oct 13, 2026 at 10:00\u202FAM Shammah <0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx> wrote:',
        )
      })

      it('prefers <username>@signet.mx over <0x-address>@signet.mx when username is published on the gateway relay', async () => {
        mockOwnAddress.value = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        const profile = useProfileStore()
        profile.owner = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        profile.unpublished = false
        profile.profile = { name: 'Shammah Chancellor', username: 'shammah' }

        const settings = useSettingsStore()
        settings.emailGatewayRelayOrigin = 'https://relay.signet.mx'
        settings.advertisedEmailGateway = {
          address: '0x3333333333333333333333333333333333333333',
          domain: 'signet.mx',
        }
        settings.acceptedEmailGateway = {
          address: '0x3333333333333333333333333333333333333333',
          domain: 'signet.mx',
          relayOrigin: 'https://relay.signet.mx',
        }
        settings.emailGatewayStatus = 'ready'

        const wrapper = mountView()
        const vm = wrapper.vm as any
        vm.replyText = 'Sending from canonical username address'
        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as { items: any[] }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem.from).toEqual({
          address: 'shammah@signet.mx',
          name: 'Shammah Chancellor',
        })
      })

      it('falls back to <0x-address>@signet.mx when user is not on the signet.mx relay or username is unpublished', async () => {
        mockOwnAddress.value = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        const profile = useProfileStore()
        profile.owner = '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3'
        profile.unpublished = false
        profile.profile = { name: 'Shammah Chancellor', username: 'shammah' }

        // Connected to a relay that is NOT the signet.mx gateway relay
        const settings = useSettingsStore()
        settings.emailGatewayRelayOrigin = 'https://other-relay.example.org'
        settings.advertisedEmailGateway = null
        settings.acceptedEmailGateway = {
          address: '0x3333333333333333333333333333333333333333',
          domain: 'signet.mx',
          relayOrigin: 'https://relay.signet.mx',
        }

        const wrapper = mountView()
        const vm = wrapper.vm as any
        vm.replyText = 'Sending while on a different relay'
        await vm.handleSend()

        expect(wrapper.emitted('sendReply')).toBeTruthy()
        const payload = wrapper.emitted('sendReply')![0][0] as { items: any[] }
        const emailItem = payload.items.find(i => i.type === 'email')
        expect(emailItem.from).toEqual({
          address: '0x10239E8fbFD030Da11Df8f452984Ebfb894d0DC3@signet.mx',
          name: 'Shammah Chancellor',
        })
      })

      it('passes matching contentStyle and contentActiveStyle to q-scroll-area so thumbHidden toggles never shift padding', () => {
        const wrapper = mountView()
        const scrollArea = wrapper.findComponent({ ref: 'emailScroll' })
        expect(scrollArea.exists()).toBe(true)
        const contentStyle = scrollArea.props('contentStyle')
        const contentActiveStyle = scrollArea.props('contentActiveStyle')
        expect(contentStyle).toBeDefined()
        expect(contentActiveStyle).toEqual(contentStyle)
        expect(contentStyle).not.toHaveProperty('padding')
      })
    })
  })
})
