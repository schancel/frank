/** @jest-environment jsdom */

import { shallowMount } from '@vue/test-utils'
import DappBridgePanel from './DappBridgePanel.vue'

describe('DappBridgePanel (#1708, #1709, #1710)', () => {
  function mountPanel(props: Record<string, any> = {}) {
    return shallowMount(DappBridgePanel, {
      props,
      global: {
        stubs: {
          QBadge: {
            props: ['label'],
            template: '<span v-bind="$attrs">{{ label }}<slot /></span>',
          },
          QCard: {
            template: '<div v-bind="$attrs"><slot /></div>',
          },
          QCardSection: {
            template: '<div v-bind="$attrs"><slot /></div>',
          },
          QCardActions: {
            template: '<div v-bind="$attrs"><slot /></div>',
          },
          QSeparator: {
            template: '<hr />',
          },
          QInput: {
            props: ['modelValue', 'label', 'placeholder'],
            emits: ['update:modelValue'],
            template:
              '<input v-bind="$attrs" :value="modelValue" @input="$emit(\'update:modelValue\', $event.target.value)" />',
          },
          QBtn: {
            props: ['label'],
            emits: ['click'],
            template:
              '<button v-bind="$attrs" @click="$emit(\'click\', $event)">{{ label }}<slot /></button>',
          },
        },
      },
    })
  }

  it('renders Standalone PWA mode badge and default Persona EOA card', () => {
    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 120,
    })

    expect(wrapper.find('[data-testid="dapp-bridge-panel"]').exists()).toBe(
      true,
    )
    expect(wrapper.find('[data-testid="dapp-runtime-mode"]').text()).toContain(
      'Standalone PWA',
    )
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/44'/60'/1'/0/0",
    )
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('5.00 MON')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '120.00 MON',
    )
    wrapper.unmount()
  })

  it('renders Browser Extension mode badge when running inside Chrome Side Panel', () => {
    const wrapper = mountPanel({
      runtimeKindOverride: 'chrome-extension',
    })
    expect(wrapper.find('[data-testid="dapp-runtime-mode"]').text()).toContain(
      'Browser Extension (Chrome Side Panel)',
    )
    wrapper.unmount()
  })

  it('supports creating a burner persona, topping up from the pool, and sweeping back to the pool', async () => {
    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 50,
    })

    await wrapper
      .find('[data-testid="dapp-topup-persona-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('15.00 MON')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '40.00 MON',
    )
    expect(wrapper.emitted('topup-persona')).toHaveLength(1)

    await wrapper.find('[data-testid="dapp-sweep-back-btn"]').trigger('click')
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('0.00 MON')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '55.00 MON',
    )
    expect(wrapper.emitted('sweep-to-pool')).toHaveLength(1)

    await wrapper
      .find('[data-testid="dapp-create-burner-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/44'/60'/1'/0/1",
    )
    expect(wrapper.emitted('create-burner')).toHaveLength(1)
    wrapper.unmount()
  })

  it('displays pending dApp approval with JIT pool sweep notice and handles Approve / Reject', async () => {
    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 100,
      initialApprovals: [
        {
          id: 'tx-1',
          origin: 'https://app.uniswap.org',
          method: 'eth_sendTransaction',
          requiredAmountMon: 20,
          summary: 'Swap 20 MON for USDC',
        },
        {
          id: 'sign-2',
          origin: 'https://opensea.io',
          method: 'personal_sign',
          summary: 'Sign login challenge',
        },
      ],
    })

    const approvalCard = wrapper.find('[data-testid="dapp-approval-card"]')
    expect(approvalCard.exists()).toBe(true)
    expect(approvalCard.text()).toContain('https://app.uniswap.org')
    expect(approvalCard.text()).toContain('+15.00 MON from Frank Pool')

    await wrapper.find('[data-testid="dapp-approve-btn"]').trigger('click')
    expect(wrapper.emitted('approve-request')).toHaveLength(1)
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '85.00 MON',
    )

    // Next approval in queue is now shown
    expect(
      wrapper.find('[data-testid="dapp-approval-card"]').text(),
    ).toContain('https://opensea.io')
    await wrapper.find('[data-testid="dapp-reject-btn"]').trigger('click')
    expect(wrapper.emitted('reject-request')).toHaveLength(1)
    expect(wrapper.find('[data-testid="dapp-approval-card"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('supports Standalone PWA WalletConnect URI pairing and 1-click Extension Sync with SAS code', async () => {
    const wrapper = mountPanel({
      initialApprovals: [],
      initialSasCode: '654321',
    })

    const syncSection = wrapper.find('[data-testid="dapp-pwa-sync-section"]')
    expect(syncSection.exists()).toBe(true)
    expect(wrapper.find('[data-testid="dapp-sync-sas-code"]').text()).toContain(
      '654321',
    )

    const input = wrapper.find('[data-testid="dapp-wc-uri-input"]')
    await input.setValue('wc:abc123def456@2?relay-protocol=irn&symKey=deadbeef')
    await wrapper.find('[data-testid="dapp-wc-connect-btn"]').trigger('click')

    expect(wrapper.emitted('wc-connect')).toEqual([
      [{ uri: 'wc:abc123def456@2?relay-protocol=irn&symKey=deadbeef' }],
    ])
    expect(
      wrapper.find('[data-testid="dapp-approval-card"]').exists(),
    ).toBe(true)

    await wrapper
      .find('[data-testid="dapp-extension-sync-btn"]')
      .trigger('click')
    expect(wrapper.emitted('extension-sync')).toHaveLength(1)
    expect(wrapper.find('[data-testid="dapp-sync-sas-code"]').text()).toContain(
      '654321 (Synced)',
    )
    wrapper.unmount()
  })
})
