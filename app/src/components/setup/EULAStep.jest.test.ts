/** @jest-environment jsdom */

import { mount } from '@vue/test-utils'
import EULAStep from './EULAStep.vue'
import enUs from '../../i18n/en-us'
import frFr from '../../i18n/fr-fr'

describe('EULAStep pre-account economic and testnet disclosures (#485)', () => {
  const stubs = {
    QBanner: {
      template:
        '<div class="q-banner" :data-test="$attrs[\'data-test\']"><slot name="avatar" /><slot /></div>',
    },
    QCard: {
      template:
        '<div class="q-card" :data-test="$attrs[\'data-test\']"><slot /></div>',
    },
    QCardSection: {
      template:
        '<div class="q-card-section" :data-test="$attrs[\'data-test\']"><slot /></div>',
    },
    QList: { template: '<div class="q-list"><slot /></div>' },
    QItem: {
      template:
        '<div class="q-item" :data-test="$attrs[\'data-test\']"><slot /></div>',
    },
    QItemSection: { template: '<div class="q-item-section"><slot /></div>' },
    QItemLabel: { template: '<div class="q-item-label"><slot /></div>' },
    QSeparator: { template: '<hr />' },
    QIcon: { template: '<i :name="$attrs.name" />' },
    QSpace: { template: '<span />' },
  }

  function mountWithLocale(messages: Record<string, any>) {
    return mount(EULAStep, {
      global: {
        mocks: {
          $t: (key: string) => {
            const parts = key.split('.')
            let current: any = messages
            for (const part of parts) {
              if (current === undefined || current === null) return key
              current = current[part]
            }
            return typeof current === 'string' ? current : key
          },
        },
        stubs,
      },
    })
  }

  describe('English locale (en-US)', () => {
    it('explicitly identifies Monad testnet and states testnet MON has no real value', () => {
      const wrapper = mountWithLocale(enUs)
      const banner = wrapper.find('[data-test="eula-testnet-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('Monad Testnet')
      expect(banner.text()).toContain('testnet MON')
      expect(banner.text()).toContain('no real-world monetary value')
    })

    it('explains network and stamp costs and that actual amounts are shown before actions', () => {
      const wrapper = mountWithLocale(enUs)
      const costs = wrapper.find('[data-test="eula-costs-explanation"]')
      expect(costs.exists()).toBe(true)
      expect(costs.text()).toContain('Network and stamp costs apply')
      expect(costs.text()).toContain('always shown before you confirm')
    })

    it('distinguishes direct-message recipient payments from topic-post/vote burns in plain language', () => {
      const wrapper = mountWithLocale(enUs)

      const dmItem = wrapper.find('[data-test="eula-dm-payment"]')
      expect(dmItem.exists()).toBe(true)
      expect(dmItem.text()).toContain('Direct Messages')
      expect(dmItem.text()).toContain(
        'Paid directly to the recipient as an inbox stamp',
      )

      const topicItem = wrapper.find('[data-test="eula-topic-burn"]')
      expect(topicItem.exists()).toBe(true)
      expect(topicItem.text()).toContain('Forum Posts & Votes')
      expect(topicItem.text()).toContain(
        'Burned (permanently destroyed on-chain)',
      )
    })

    it('explains the new-user testnet funding path via demo faucet and receive screen', () => {
      const wrapper = mountWithLocale(enUs)
      const funding = wrapper.find('[data-test="eula-funding-info"]')
      expect(funding.exists()).toBe(true)
      expect(funding.text()).toContain('Testnet Funding')
      expect(funding.text()).toContain('demo faucet')
      expect(funding.text()).toContain('Receive screen')
    })
  })

  describe('French locale (fr-FR)', () => {
    it('explicitly identifies Monad testnet and states testnet MON has no real value in French', () => {
      const wrapper = mountWithLocale(frFr)
      const banner = wrapper.find('[data-test="eula-testnet-banner"]')
      expect(banner.exists()).toBe(true)
      expect(banner.text()).toContain('Testnet Monad')
      expect(banner.text()).toContain('MON de testnet')
      expect(banner.text()).toContain('aucune valeur monétaire réelle')
    })

    it('explains network and stamp costs in French', () => {
      const wrapper = mountWithLocale(frFr)
      const costs = wrapper.find('[data-test="eula-costs-explanation"]')
      expect(costs.exists()).toBe(true)
      expect(costs.text()).toContain('coûts de réseau et de timbre')
      expect(costs.text()).toContain('toujours affiché avant de confirmer')
    })

    it('distinguishes direct messages from burns in French', () => {
      const wrapper = mountWithLocale(frFr)

      const dmItem = wrapper.find('[data-test="eula-dm-payment"]')
      expect(dmItem.exists()).toBe(true)
      expect(dmItem.text()).toContain('Messages directs')
      expect(dmItem.text()).toContain('Payés directement au destinataire')

      const topicItem = wrapper.find('[data-test="eula-topic-burn"]')
      expect(topicItem.exists()).toBe(true)
      expect(topicItem.text()).toContain('Publications et votes de forum')
      expect(topicItem.text()).toContain('Détruits de manière permanente')
    })

    it('explains funding path in French', () => {
      const wrapper = mountWithLocale(frFr)
      const funding = wrapper.find('[data-test="eula-funding-info"]')
      expect(funding.exists()).toBe(true)
      expect(funding.text()).toContain('Financement de testnet')
      expect(funding.text()).toContain('faucet de démonstration')
      expect(funding.text()).toContain('Recevoir')
    })
  })

  describe('Locale parity', () => {
    const requiredSetupKeys = [
      'networkTitle',
      'testnetDisclaimer',
      'economicModelTitle',
      'costsDisclaimer',
      'directMessagesTitle',
      'directMessagesDesc',
      'topicActionsTitle',
      'topicActionsDesc',
      'fundingTitle',
      'fundingDesc',
    ]

    it.each(requiredSetupKeys)(
      'contains non-empty key "%s" in both en-US and fr-FR',
      key => {
        const enValue = (enUs.setup as Record<string, string>)[key]
        const frValue = (frFr.setup as Record<string, string>)[key]

        expect(typeof enValue).toBe('string')
        expect(enValue.trim().length).toBeGreaterThan(0)

        expect(typeof frValue).toBe('string')
        expect(frValue.trim().length).toBeGreaterThan(0)
      },
    )
  })
})
