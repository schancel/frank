/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import EmailThreadView from './EmailThreadView.vue'
import type { ChatMessage, Conversation } from 'src/stores/chats'
import type { EmailItem } from '@frank/cashweb/types/messages'
import { useSettingsStore } from 'src/stores/settings'

describe('EmailThreadView', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
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
    address: '0xGateway',
    participants: ['0xGateway', '0xMe'],
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
          'q-banner': { template: '<div class="q-banner"><slot name="avatar" /><slot /></div>' },
          'q-card': { template: '<div class="q-card"><slot /></div>' },
          'q-card-section': { template: '<div class="q-card-section"><slot /></div>' },
          'q-card-actions': { template: '<div class="q-card-actions"><slot /></div>' },
          'q-item': { template: '<div class="q-item" @click="$emit(\'click\')"><slot /></div>' },
          'q-item-section': { template: '<div class="q-item-section"><slot /></div>' },
          'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
          'q-badge': { template: '<span class="q-badge"><slot /></span>' },
          'q-btn': {
            props: ['label'],
            emits: ['click'],
            template: '<button class="q-btn" @click="$emit(\'click\', $event)"><slot>{{ label }}</slot></button>',
          },
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
      expect(wrapper.find('[data-testid="email-gateway-badge"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="unverified-p2p-badge"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="unverified-peer-warning-banner"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="composer-unverified-warning"]').exists()).toBe(false)
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
      expect(wrapper.find('[data-testid="email-gateway-badge"]').exists()).toBe(false)
      // Unverified badge must be shown
      const unverifiedBadge = wrapper.find('[data-testid="unverified-p2p-badge"]')
      expect(unverifiedBadge.exists()).toBe(true)
      expect(unverifiedBadge.text()).toContain('⚠️ Direct P2P Email (Unverified)')

      // Warning banner must be prominently shown with the exact required wording
      const banner = wrapper.find('[data-testid="unverified-peer-warning-banner"]')
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

    it('guards composer replies: warns user and defaults to Frank P2P direct delivery', () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any

      // Composer notice is visible
      const composerWarning = wrapper.find('[data-testid="composer-unverified-warning"]')
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
      vm.handleSend()

      expect(wrapper.emitted('sendReply')).toBeTruthy()
      const emitted = wrapper.emitted('sendReply')![0][0] as {
        items: any[]
        fallbackText: string
        targetAddress?: string
      }
      expect(emitted.fallbackText).toContain('[Direct P2P Email to ' + peerAddress)
      expect(emitted.fallbackText).toContain('(external email recipients not notified)')
      expect(emitted.targetAddress).toBeUndefined()
    })

    it('allows routing through gateway if user chooses to bridge via gateway', () => {
      const wrapper = mountView({
        conversation: unverifiedPeerConversation,
        messages: [peerMessage],
        recipientAddress: peerAddress,
      })
      const vm = wrapper.vm as any

      // Switch routing to gateway
      vm.replyRouting = 'gateway'
      expect(vm.sendButtonLabel).toBe('Bridge via Gateway')
      expect(vm.sendButtonTooltip).toContain('Route through Frank Email Gateway')

      vm.replyText = 'Sending via gateway instead.'
      vm.handleSend()

      const emitted = wrapper.emitted('sendReply')![0][0] as {
        items: any[]
        fallbackText: string
        targetAddress?: string
      }
      expect(emitted.fallbackText).toContain('[Email to ')
      expect(emitted.targetAddress).toBe('0x1111111111111111111111111111111111111111')
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
      expect(wrapper.find('[data-testid="email-draft-placeholder"]').exists()).toBe(true)
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

      vm.handleSend()

      expect(wrapper.emitted('sendReply')).toBeTruthy()
      const emittedCalls = wrapper.emitted('sendReply')!
      expect(emittedCalls.length).toBe(1)

      const payload = emittedCalls[0][0] as { items: any[]; fallbackText: string }
      expect(payload.items.length).toBe(2)

      const emailItem = payload.items.find(i => i.type === 'email')
      expect(emailItem).toBeDefined()
      expect(emailItem.to).toEqual([{ address: 'charlie@example.com' }])
      expect(emailItem.subject).toBe('Meeting Tomorrow')
      expect(emailItem.textBody).toBe('Hi Charlie, let us meet tomorrow at 10am.')
      expect(emailItem.inReplyTo).toBeUndefined()

      const textItem = payload.items.find(i => i.type === 'text')
      expect(textItem).toBeDefined()
      expect(textItem.text).toContain('Meeting Tomorrow')
      expect(textItem.text).toContain('Hi Charlie, let us meet tomorrow at 10am.')
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
        expect(wrapper.find('[data-testid="staged-attachments-container"]').exists()).toBe(false)

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
        const container = wrapper.find('[data-testid="staged-attachments-container"]')
        expect(container.exists()).toBe(true)

        const chips = wrapper.findAll('.staged-attachment-chip')
        expect(chips.length).toBe(2)
        expect(chips[0].text()).toContain('test-document.pdf')
        expect(chips[0].text()).toContain('24 KB')
        expect(chips[1].text()).toContain('avatar.png')
        expect(chips[1].text()).toContain('1 MB')

        // Remove the first attachment via remove button
        const removeButtons = wrapper.findAll('[data-testid="remove-attachment-btn"]')
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

        jest.spyOn(vm, 'readFileAsBase64').mockResolvedValue('data:text/plain;base64,SGVsbG8=')

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
          htmlBody: '<h1>Weekly Digest</h1><p>Welcome to <b>Frank</b>!</p><script>alert("evil")</script>',
        }

        const msgWithHtml: ChatMessage = {
          outbound: false,
          status: 'confirmed',
          receivedTime: 5000,
          serverTime: 5000,
          items: [emailWithHtml],
          outpoints: [],
          senderAddress: '0xGateway',
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
        expect(wrapper.find('.email-body-text').text()).toContain('Plain text version of weekly digest.')

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
  })
})
