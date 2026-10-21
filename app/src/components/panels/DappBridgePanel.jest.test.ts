/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { HDNodeWallet } from 'ethers'
import {
  deriveDappPersona,
  type DappPersonaRef,
} from '@frank/wallet/dapp-bridge/persona-keys'
import DappBridgePanel from './DappBridgePanel.vue'

// Narrow seam: the session's persona capability, backed by a fixed test account master.
const testMaster = HDNodeWallet.fromSeed(new Uint8Array(32).fill(7))
jest.mock('src/accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: {
    getWallet: () => Promise.reject(new Error('no wallet in unit tests')),
    createDappPersonaSigner: () =>
      Promise.resolve({
        accountId: 'test-account',
        addresses: (refs: readonly DappPersonaRef[]) =>
          Promise.resolve(
            refs.map(ref => deriveDappPersona(testMaster, ref).address),
          ),
        signDigest: (ref: DappPersonaRef, digest: string) =>
          Promise.resolve(
            deriveDappPersona(testMaster, ref).node.signingKey.sign(digest)
              .serialized,
          ),
      }),
  },
}))

describe('DappBridgePanel (#1708, #1709, #1710)', () => {
  function mountPanel(props: Record<string, any> = {}) {
    return shallowMount(DappBridgePanel, {
      props,
      global: {
        stubs: {
          QIcon: true,
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

  it('renders Standalone PWA mode badge, extension download card, and default Persona EOA card', async () => {
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
    const downloadCard = wrapper.find(
      '[data-testid="dapp-extension-download-card"]',
    )
    expect(downloadCard.exists()).toBe(true)
    expect(downloadCard.text()).toContain('Install Frank Browser Extension')
    expect(
      wrapper.find('[data-testid="dapp-download-chrome-btn"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-testid="dapp-download-firefox-btn"]').exists(),
    ).toBe(true)
    expect(
      wrapper.find('[data-testid="dapp-download-safari-btn"]').exists(),
    ).toBe(true)
    await flushPromises()
    await wrapper
      .find('[data-testid="dapp-download-firefox-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-testid="dapp-extension-install-hint"]').text(),
    ).toContain('about:debugging')

    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/1785'/60'/0'/0'",
    )
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('5.00 MON')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '120.00 MON',
    )
    wrapper.unmount()
  })

  it('renders Browser Extension mode badge without hardcoded demo balances or duplicate view bar', () => {
    const wrapper = mountPanel({
      runtimeKindOverride: 'chrome-extension',
    })
    expect(wrapper.find('[data-testid="dapp-runtime-mode"]').text()).toContain(
      'Browser Extension (Chrome Side Panel)',
    )
    expect(
      wrapper.find('[data-testid="dapp-extension-download-card"]').exists(),
    ).toBe(false)
    expect(wrapper.find('[data-testid="extension-view-bar"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('0.00 MON')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '0.00 MON',
    )
    expect(wrapper.find('[data-testid="dapp-approval-card"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('in the extension, shows waiting dApp requests read-only; they are answered in the approval window', async () => {
    const g = globalThis as any
    const previousChrome = g.chrome
    const sendMessage = jest.fn(async (msg: any) =>
      msg?.type === 'get-bridge-state'
        ? {
            ok: true,
            result: {
              pendingApprovals: [
                { id: 'r1', kind: 'connect', origin: 'https://app.uniswap.org', method: 'eth_requestAccounts' },
                { id: 'r2', kind: 'sign', origin: 'https://app.uniswap.org', method: 'personal_sign' },
              ],
            },
          }
        : { ok: true },
    )
    g.chrome = {
      runtime: {
        id: 'frank-test-ext',
        sendMessage,
        onMessage: { addListener: jest.fn(), removeListener: jest.fn() },
      },
    }
    try {
      const wrapper = mountPanel({ runtimeKindOverride: 'chrome-extension' })
      await new Promise(resolve => setTimeout(resolve, 0))
      await wrapper.vm.$nextTick()
      expect(
        wrapper.find('[data-testid="dapp-requests-waiting"]').text(),
      ).toContain('2 dApp requests are waiting in the Frank approval window.')
      expect(wrapper.find('[data-testid="dapp-approval-card"]').exists()).toBe(
        false,
      )
      // The panel never answers a background request itself.
      expect(
        sendMessage.mock.calls.some(([msg]) =>
          String(msg?.type).includes('resolve-approval'),
        ),
      ).toBe(false)
      wrapper.unmount()
    } finally {
      g.chrome = previousChrome
    }
  })

  it('supports creating a burner persona, topping up from the pool, and sweeping back to the pool', async () => {
    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 50,
    })
    await flushPromises()

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
      .find('[data-testid="dapp-topup-persona-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('10.00 MON')

    await wrapper
      .find('[data-testid="dapp-create-burner-btn"]')
      .trigger('click')
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/1785'/60'/0'/1'",
    )
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('0.00 MON')
    expect(wrapper.emitted('create-burner')).toHaveLength(1)

    // Switch back to Default #0 and verify its 10.00 MON balance is preserved
    await wrapper
      .find('[data-testid="dapp-select-persona-0"]')
      .trigger('click')
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/1785'/60'/0'/0'",
    )
    expect(
      wrapper.find('[data-testid="dapp-persona-balance"]').text(),
    ).toContain('10.00 MON')
    expect(wrapper.emitted('select-persona')).toHaveLength(1)
    wrapper.unmount()
  })

  it('offers only Reject for signing and transaction requests: Frank has no website signer', async () => {
    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 100,
      initialApprovals: [
        {
          id: 'tx-1',
          origin: 'https://app.uniswap.org',
          method: 'eth_sendTransaction',
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
    expect(approvalCard.text()).not.toContain('Frank Pool')

    expect(wrapper.find('[data-testid="dapp-approve-btn"]').exists()).toBe(false)
    await wrapper.find('[data-testid="dapp-reject-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toContain(
      '100.00 MON',
    )

    // Next approval in queue is now shown
    expect(
      wrapper.find('[data-testid="dapp-approval-card"]').text(),
    ).toContain('https://opensea.io')
    expect(wrapper.find('[data-testid="dapp-approve-btn"]').exists()).toBe(false)
    await wrapper.find('[data-testid="dapp-reject-btn"]').trigger('click')
    expect(wrapper.emitted('reject-request')).toHaveLength(2)
    expect(wrapper.find('[data-testid="dapp-approval-card"]').exists()).toBe(
      false,
    )
    wrapper.unmount()
  })

  it('explains account sync and reports unsupported WalletConnect without claiming pairing', () => {
    const wrapper = mountPanel({ initialApprovals: [] })
    expect(
      wrapper.get('[data-testid="dapp-account-sync-help"]').text(),
    ).toContain('Sync account')
    expect(wrapper.get('[data-testid="dapp-wc-unsupported"]').text()).toContain(
      'not supported yet',
    )
    expect(wrapper.find('[data-testid="dapp-wc-connect-btn"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="dapp-wc-paired-status"]').exists()).toBe(
      false,
    )
    expect(wrapper.find('[data-testid="dapp-approval-card"]').exists()).toBe(
      false,
    )
    expect(wrapper.emitted('wc-connect')).toBeUndefined()
    wrapper.unmount()
  })

  it('automatically discovers used burner personas on-chain and provides a dropdown selector', async () => {
    const { discoverUsedPersonasOnChain } = await import('./DappBridgePanel.vue')

    const slotAddresses = Array.from(
      { length: 11 },
      (_, slot) => deriveDappPersona(testMaster, { kind: 'shared', slot }).address,
    )
    const burner2Address = slotAddresses[2].toLowerCase()

    const mockFetch = jest.fn(async (_url: string, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body ?? '[]')) as Array<{
        id: string
        method: string
        params: [string, string]
      }>
      const response = batch.map(item => {
        const addr = item.params[0].toLowerCase()
        if (addr === burner2Address && item.method === 'eth_getBalance') {
          // 2.5 MON in hex wei (2_500_000_000_000_000_000 = 0x22b1c8c1227a0000)
          return { jsonrpc: '2.0', id: item.id, result: '0x22b1c8c1227a0000' }
        }
        if (addr === burner2Address && item.method === 'eth_getTransactionCount') {
          return { jsonrpc: '2.0', id: item.id, result: '0x3' }
        }
        return { jsonrpc: '2.0', id: item.id, result: '0x0' }
      })
      return {
        ok: true,
        json: async () => response,
      } as unknown as Response
    })

    const discovered = await discoverUsedPersonasOnChain(slotAddresses, {
      fetchImpl: mockFetch as unknown as typeof fetch,
      gapLimit: 3,
    })

    const burner2Entry = discovered.find(item => item.index === 2)
    expect(burner2Entry).toBeDefined()
    expect(burner2Entry?.used).toBe(true)
    expect(burner2Entry?.balanceMon).toBeCloseTo(2.5, 2)
    expect(burner2Entry?.txCount).toBe(3)

    const wrapper = mountPanel({
      initialPersonaBalanceMon: 5,
      initialPoolBalanceMon: 50,
    })
    await wrapper.find('[data-testid="dapp-create-burner-btn"]').trigger('click')
    await wrapper.find('[data-testid="dapp-create-burner-btn"]').trigger('click')

    const dropdown = wrapper.find('[data-testid="dapp-persona-dropdown"]')
    expect(dropdown.exists()).toBe(true)
    expect(dropdown.findAll('option')).toHaveLength(3)

    await dropdown.setValue('1')
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/1785'/60'/0'/1'",
    )
    wrapper.unmount()
  })

  it('allows switching between Per-Site Burner Persona and Shared Primary Persona on connect approval and updates privacy controls', async () => {
    const wrapper = mountPanel({
      initialApprovals: [
        {
          id: 'connect-1',
          origin: 'https://app.uniswap.org',
          method: 'eth_requestAccounts',
          kind: 'connect',
          summary: 'Connect https://app.uniswap.org to your Frank dApp Persona',
        },
      ],
    })

    await flushPromises()
    const modeSelector = wrapper.find(
      '[data-testid="dapp-connect-persona-choice"]',
    )
    expect(modeSelector.exists()).toBe(true)

    const burnerAddrPreview = wrapper
      .find('[data-testid="dapp-connect-preview-address"]')
      .text()
      .trim()
    // The per-site preview is the custody-derived site persona.
    expect(burnerAddrPreview).toBe(
      deriveDappPersona(testMaster, {
        kind: 'site',
        origin: 'https://app.uniswap.org',
      }).address,
    )

    // Switch to Shared Primary Persona and verify preview address changes to primary persona #0
    await wrapper
      .find('[data-testid="dapp-connect-mode-primary"]')
      .trigger('click')
    const primaryAddrPreview = wrapper
      .find('[data-testid="dapp-connect-preview-address"]')
      .text()
      .trim()
    expect(primaryAddrPreview).toBe(
      deriveDappPersona(testMaster, { kind: 'shared', slot: 0 }).address,
    )
    expect(primaryAddrPreview.toLowerCase()).not.toBe(
      burnerAddrPreview.toLowerCase(),
    )

    // Switch back to Per-Site Burner Persona and approve
    await wrapper
      .find('[data-testid="dapp-connect-mode-burner"]')
      .trigger('click')
    await wrapper.find('[data-testid="dapp-approve-btn"]').trigger('click')
    await flushPromises()

    // Verify site now appears in Connected Sites list with its isolated burner persona badge
    const connectedList = wrapper.find(
      '[data-testid="dapp-connected-sites-list"]',
    )
    expect(connectedList.exists()).toBe(true)
    expect(connectedList.text()).toContain('https://app.uniswap.org')

    // Disconnect site from Connected Sites list
    await wrapper
      .find('[data-testid="dapp-disconnect-origin-btn"]')
      .trigger('click')
    expect(
      wrapper.find('[data-testid="dapp-connected-sites-list"]').exists(),
    ).toBe(false)

    // Toggle EIP-6963 provider visibility mode (always -> stealth -> connected-only)
    expect(wrapper.find('[data-testid="dapp-privacy-card"]').exists()).toBe(
      true,
    )
    await wrapper
      .find('[data-testid="dapp-announce-mode-stealth"]')
      .trigger('click')
    await wrapper
      .find('[data-testid="dapp-announce-mode-connected-only"]')
      .trigger('click')

    wrapper.unmount()
  })
})
