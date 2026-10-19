/** @jest-environment jsdom */

import fs from 'fs'
import path from 'path'
import { ref } from 'vue'
import { shallowMount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import EmailThreadView from '../components/chat/email/EmailThreadView.vue'
import ChatInput from '../components/chat/ChatInput.vue'
import { useSettingsStore } from '../stores/settings'
import { useProfileStore } from '../stores/my-profile'
import type { ChatMessage, Conversation } from '../stores/chats'
import type { EmailItem } from '@frank/cashweb/types/messages'

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

const APP_SRC_DIR = path.resolve(__dirname, '..')
const APP_SCSS_PATH = path.resolve(__dirname, 'app.scss')

function collectVueFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectVueFiles(full, out)
    } else if (entry.name.endsWith('.vue')) {
      out.push(full)
    }
  }
  return out
}

describe('UI Consistency & Rendering Glitch Contract Gate', () => {
  const appScss = fs.readFileSync(APP_SCSS_PATH, 'utf8')

  describe('1. Global Button, Pill & Control Design System (app.scss)', () => {
    it('enforces sentence-case typography and non-wrapping content on all .q-btn elements globally', () => {
      expect(appScss).toMatch(
        /\.q-btn\s*\{[\s\S]*?text-transform:\s*none\s*!important/,
      )
      expect(appScss).toMatch(
        /\.q-btn[\s\S]*?\.q-btn__content\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*!important/,
      )
    })

    it('defines consistent rounded border-radius and tonal button rules across the app', () => {
      expect(appScss).toMatch(
        /\.q-btn:not\(\.q-btn--round\):not\(\.q-btn--rounded\)\s*\{[\s\S]*?border-radius:\s*10px/,
      )
      expect(appScss).toMatch(/\.q-btn--rounded\s*\{[\s\S]*?border-radius:\s*999px/)
      expect(appScss).toMatch(/\.frank-tonal-btn\s*\{[\s\S]*?border-radius:\s*10px/)
    })

    it('defines canonical non-wrapping .chat-stamp-btn with auto height so multiplier badges never overflow', () => {
      expect(appScss).toMatch(
        /\.chat-stamp-btn\s*\{[\s\S]*?min-height:\s*28px[\s\S]*?height:\s*auto[\s\S]*?border-radius:\s*999px\s*!important[\s\S]*?white-space:\s*nowrap/,
      )
      expect(appScss).toMatch(
        /\.chat-stamp-btn[\s\S]*?\.q-btn__content\s*\{[\s\S]*?flex-wrap:\s*nowrap\s*!important/,
      )
    })
  })

  describe('2. Component Style Scoping & Fixed-Height Pill Hazard Scan', () => {
    const componentVueFiles = [
      ...collectVueFiles(path.join(APP_SRC_DIR, 'components')),
      ...collectVueFiles(path.join(APP_SRC_DIR, 'pages')),
    ]

    it('requires every <style> block in components/ and pages/ to be scoped so styles never leak across views', () => {
      const unscopedFiles: string[] = []
      for (const file of componentVueFiles) {
        const content = fs.readFileSync(file, 'utf8')
        const styleTags = [...content.matchAll(/<style\b([^>]*)>/g)]
        for (const match of styleTags) {
          if (!/\bscoped\b/.test(match[1])) {
            unscopedFiles.push(path.relative(APP_SRC_DIR, file))
          }
        }
      }
      expect(unscopedFiles).toEqual([])
    })

    it('forbids fixed height: 28px on .chat-stamp-btn in any component (must use min-height: 28px and height: auto)', () => {
      const violations: string[] = []
      for (const file of componentVueFiles) {
        const content = fs.readFileSync(file, 'utf8')
        const stampBtnBlock = content.match(/\.chat-stamp-btn\s*\{([^}]*)\}/)
        if (stampBtnBlock) {
          const body = stampBtnBlock[1]
          if (/(?:^|[\s;])height:\s*28px\b/.test(body)) {
            violations.push(path.relative(APP_SRC_DIR, file))
          }
        }
      }
      expect(violations).toEqual([])
    })
  })

  describe('3. Email Composer & ChatInput Stress-Value Layout Invariants', () => {
    beforeEach(() => {
      setActivePinia(createPinia())
      mockOwnAddress.value = '0x1111111111111111111111111111111111111111'
      useSettingsStore().setEmailGatewayAddress(
        '0x3333333333333333333333333333333333333333',
      )
      useProfileStore().owner = '0x1111111111111111111111111111111111111111'
      useProfileStore().profile = { name: 'Shammah' }
    })

    const sampleEmail: EmailItem = {
      type: 'email',
      messageId: '<msg1@signet.mx>',
      from: { address: 'shammah.chancellor@gmail.com', name: 'Shammah Chancellor' },
      to: [{ address: 'micropresident@signet.mx', name: 'Shammah' }],
      subject: 'Hello there',
      textBody: 'Not much. How are you?',
      htmlBody: '<p>Not much. How are you?</p>',
    }

    const messages: ChatMessage[] = [
      {
        outbound: false,
        status: 'confirmed',
        receivedTime: 1000,
        serverTime: 1000,
        items: [sampleEmail],
        outpoints: [],
        senderAddress: '0x3333333333333333333333333333333333333333',
        payloadDigest: 'digest-1',
      },
    ]

    const conversation: Conversation = {
      id: 'conv-stress',
      kind: 'email',
      name: 'Hello there',
      address: '0x3333333333333333333333333333333333333333',
      participants: ['0x3333333333333333333333333333333333333333'],
      messages,
      totalUnreadMessages: 0,
      totalUnreadValue: 0,
      totalValue: 0,
      lastReceived: 1000,
      lastRead: 1000,
      stampAmount: 100,
      verifiedGateway: true,
    }

    it('renders long stampStatus in its own row outside composer-top-actions so Send button never wraps onto a new line', () => {
      const longStatus =
        'The network cannot be reached. Paid messages are queued and will be sent when it is back.'
      const wrapper = shallowMount(EmailThreadView, {
        props: {
          conversation,
          messages,
          sending: false,
          recipientAddress: conversation.address,
          stampAmount: '20.6019',
          defaultStampWei: 439800000000000000n,
          defaultStampMode: false,
          stampStatus: longStatus,
        },
        global: {
          mocks: {
            $t: (key: string, fallback?: string) => fallback || key,
            $q: { dark: { isActive: false } },
          },
          stubs: {
            'q-page': { template: '<div class="q-page"><slot /></div>' },
            'q-scroll-area': { template: '<div class="q-scroll-area"><slot /></div>' },
            'q-banner': { template: '<div class="q-banner"><slot /></div>' },
            'q-card': { template: '<div class="q-card"><slot /></div>' },
            'q-card-section': { template: '<div class="q-card-section"><slot /></div>' },
            'q-card-actions': { template: '<div class="q-card-actions"><slot /></div>' },
            'q-item': { template: '<div class="q-item"><slot /></div>' },
            'q-item-section': { template: '<div class="q-item-section"><slot /></div>' },
            'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
            'q-badge': { template: '<span class="q-badge"><slot /></span>' },
            'q-btn': {
              props: ['label', 'noCaps', 'unelevated', 'flat', 'rounded', 'round'],
              template:
                '<button class="q-btn" :data-no-caps="noCaps !== undefined && noCaps !== false"><slot>{{ label }}</slot></button>',
            },
            'q-btn-toggle': { template: '<div class="q-btn-toggle" />' },
            'q-chip': { template: '<div class="q-chip"><slot /></div>' },
            'q-input': { template: '<input class="q-input" />' },
            'q-separator': { template: '<hr />' },
            'q-icon': { template: '<i class="q-icon" />' },
            'q-tooltip': { template: '<span class="q-tooltip"><slot /></span>' },
            'q-slide-transition': { template: '<div><slot /></div>' },
            'q-menu': { template: '<div class="q-menu"><slot /></div>' },
            'q-slider': { template: '<div class="q-slider" />' },
            'q-space': { template: '<div class="q-space" />' },
          },
        },
      })

      // 1. Long stampStatus is rendered in its dedicated status banner, NOT inside composer-top-actions
      const statusBanner = wrapper.find('[data-testid="composer-stamp-status"]')
      expect(statusBanner.exists()).toBe(true)
      expect(statusBanner.text()).toContain(longStatus)

      const topActions = wrapper.find('[data-testid="composer-top-actions"]')
      expect(topActions.exists()).toBe(true)
      expect(topActions.classes()).toContain('no-wrap')
      expect(topActions.text()).not.toContain(longStatus)

      const headerBar = wrapper.find('.composer-header-bar')
      expect(headerBar.classes()).toContain('no-wrap')

      // 2. Extreme multiplier (~46.8438x) renders inside .chat-stamp-btn with nowrap classes
      const stampBtn = wrapper.find('[data-testid="email-stamp-btn"]')
      expect(stampBtn.exists()).toBe(true)
      expect(stampBtn.classes()).toContain('chat-stamp-btn')
      const multSpan = stampBtn.find('[data-testid="stamp-pill-multiple"]')
      expect(multSpan.exists()).toBe(true)
      expect(multSpan.text()).toMatch(/^≈46\.8438×$/)

      // 3. All labeled buttons in EmailThreadView have no-caps enabled and unified theme classes
      const tonalBtns = wrapper.findAll('.frank-tonal-btn')
      expect(tonalBtns.length).toBeGreaterThanOrEqual(4)
      for (const btn of tonalBtns) {
        expect(btn.attributes('data-no-caps')).toBe('true')
      }

      wrapper.unmount()
    })

    it('renders extreme stamp multiplier in ChatInput.vue with matching .chat-stamp-btn structure', () => {
      const wrapper = shallowMount(ChatInput, {
        props: {
          message: 'Test message',
          stampAmount: '20.6019',
          defaultStampWei: 439800000000000000n,
          defaultStampMode: false,
        },
        global: {
          mocks: {
            $t: (key: string, fallback?: string) => fallback || key,
          },
          directives: {
            'close-popup': {},
          },
          stubs: {
            'q-toolbar': { template: '<div class="q-toolbar"><slot /></div>' },
            'q-btn': {
              props: ['label', 'noCaps'],
              template:
                '<button class="q-btn" :data-no-caps="noCaps !== undefined && noCaps !== false"><slot>{{ label }}</slot></button>',
            },
            'q-input': { template: '<input class="q-input" />' },
            'q-menu': { template: '<div class="q-menu"><slot /></div>' },
            'q-list': { template: '<div class="q-list"><slot /></div>' },
            'q-item': { template: '<div class="q-item"><slot /></div>' },
            'q-item-section': { template: '<div class="q-item-section"><slot /></div>' },
            'q-avatar': { template: '<div class="q-avatar"><slot /></div>' },
            'q-icon': { template: '<i class="q-icon" />' },
            'q-tooltip': { template: '<span class="q-tooltip"><slot /></span>' },
            'q-badge': { template: '<span class="q-badge"><slot /></span>' },
            'q-slider': { template: '<div class="q-slider" />' },
            'q-chip': { template: '<div class="q-chip"><slot /></div>' },
          },
        },
      })

      const stampBtn = wrapper.find('.chat-stamp-btn')
      expect(stampBtn.exists()).toBe(true)
      expect(stampBtn.attributes('data-no-caps')).toBe('true')
      const multSpan = stampBtn.find('[data-testid="stamp-pill-multiple"]')
      expect(multSpan.exists()).toBe(true)
      expect(multSpan.text()).toMatch(/^≈46\.8438×$/)

      wrapper.unmount()
    })
  })
})
