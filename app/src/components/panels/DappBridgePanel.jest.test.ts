/** @jest-environment jsdom */

import { flushPromises, shallowMount } from '@vue/test-utils'
import { HDNodeWallet } from 'ethers'
import {
  deriveDappPersona,
  type DappPersonaRef,
} from '@frank/wallet/dapp-bridge/persona-keys'
import { Transaction } from 'ethers'
import DappBridgePanel from './DappBridgePanel.vue'
import enUS from '../../i18n/en-us'

// Narrow seam: the session's persona capability, backed by a fixed test account master.
const testMaster = HDNodeWallet.fromSeed(new Uint8Array(32).fill(7))
const WALLET_ADDRESS = '0x' + '5a'.repeat(20)
const mockGetWallet = jest.fn(async () => ({
  chainIdentifier: 'monad-regtest',
  getReceiveAddress: async () => ({ raw: WALLET_ADDRESS }),
}))
// The wallet's own balance on the network: 1.5 MONR.
// eslint-disable-next-line no-var -- hoisted with jest.mock, read lazily
var mockHostRelay: string | undefined
jest.mock('@frank/wallet/chain/evm-chain', () => ({
  ...jest.requireActual('@frank/wallet/chain/evm-chain'),
  loadMonadChainConfigFromEnv: () => ({
    ...jest
      .requireActual('@frank/wallet/chain/evm-chain')
      .loadMonadChainConfigFromEnv(),
    relayBaseUrl: mockHostRelay ?? '',
  }),
}))

jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    total: { value: 1_500_000_000_000_000_000n },
  }),
}))
const RELAY = 'http://relay.test'
const RPC = `${RELAY}/chain-rpc/monad-regtest/rpc`
const ONE = 10n ** 18n
/** The relay's JSON-RPC route: balances by address, and every raw transaction sent. */
const chainBalances = new Map<string, bigint>()
const sentRaw: string[] = []
let refuseSend: string | undefined
const rpcCalls: Array<{ url: string; method: string }> = []
function answer(item: { id: number; method: string; params: unknown[] }) {
  rpcCalls.push({ url: '', method: item.method })
  const address = String(item.params[0] ?? '').toLowerCase()
  switch (item.method) {
    case 'eth_getBalance':
      return {
        jsonrpc: '2.0',
        id: item.id,
        result: '0x' + (chainBalances.get(address) ?? 0n).toString(16),
      }
    case 'eth_getTransactionCount':
      return { jsonrpc: '2.0', id: item.id, result: '0x0' }
    case 'eth_gasPrice':
      return { jsonrpc: '2.0', id: item.id, result: '0x3b9aca00' } // 1 gwei
    case 'eth_sendRawTransaction':
      if (refuseSend)
        return { jsonrpc: '2.0', id: item.id, error: { message: refuseSend } }
      sentRaw.push(String(item.params[0]))
      return { jsonrpc: '2.0', id: item.id, result: '0x' + '9'.repeat(64) }
  }
  return { jsonrpc: '2.0', id: item.id, result: '0x0' }
}
const mockFetch = jest.fn(async (url: string, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body))
  const result = Array.isArray(body) ? body.map(answer) : answer(body)
  for (const call of rpcCalls) if (!call.url) call.url = url
  return { ok: true, json: async () => result } as unknown as Response
})
const persona = (slot: number) =>
  deriveDappPersona(testMaster, { kind: 'shared', slot }).address
jest.mock('src/accounts/session', () => ({
  accountStatus: { status: 'ready' },
  accountSession: {
    getWallet: () => mockGetWallet(),
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
  const previousFetch = globalThis.fetch
  beforeEach(() => {
    mockHostRelay = RELAY
    globalThis.fetch = mockFetch as unknown as typeof fetch
    chainBalances.clear()
    sentRaw.length = 0
    rpcCalls.length = 0
    refuseSend = undefined
    mockFetch.mockClear()
    window.localStorage.clear()
  })
  afterAll(() => {
    globalThis.fetch = previousFetch
  })
  function mountPanel(props: Record<string, any> = {}) {
    return shallowMount(DappBridgePanel, {
      props: { chainIdentifier: 'monad-regtest', ...props },
      global: {
        mocks: {
          $t: (key: string, params: Record<string, unknown> = {}) => {
            const value = key
              .split('.')
              .reduce<unknown>(
                (node, part) => (node as Record<string, unknown>)?.[part],
                enUS,
              )
            return typeof value === 'string'
              ? value.replace(/\{(\w+)\}/g, (_match, name: string) =>
                  String(params[name]),
                )
              : key
          },
        },
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
    chainBalances.set(persona(0).toLowerCase(), 5n * ONE)
    const wrapper = mountPanel()

    expect(wrapper.find('[data-testid="dapp-bridge-panel"]').exists()).toBe(
      true,
    )
    // The host the page is served from, not an assumed production one.
    expect(wrapper.find('[data-testid="dapp-runtime-mode"]').text()).toBe(
      `Standalone PWA (${window.location.host})`,
    )
    expect(wrapper.text()).not.toContain('signet.mx)')
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
    // Read from the chain through the relay's route for this network, in its own unit.
    expect(wrapper.find('[data-testid="dapp-persona-balance"]').text()).toBe(
      '5 MONR',
    )
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toBe(
      '1.5 MONR',
    )
    expect(rpcCalls.every(call => call.url === RPC)).toBe(true)
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
    // Nothing read yet: no balance is shown, never an invented zero.
    expect(wrapper.find('[data-testid="dapp-persona-balance"]').text()).toBe(
      '—',
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
                {
                  id: 'r1',
                  kind: 'connect',
                  origin: 'https://app.uniswap.org',
                  method: 'eth_requestAccounts',
                },
                {
                  id: 'r2',
                  kind: 'sign',
                  origin: 'https://app.uniswap.org',
                  method: 'personal_sign',
                },
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

  it('tops up through the Send page: the exact amount is chosen, reviewed and confirmed there', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    const topUp = wrapper.get('[data-testid="dapp-topup-persona-btn"]')
    // Nothing moves on this click and no balance changes here.
    expect(topUp.attributes('to')).toBeDefined()
    const vm = wrapper.vm as unknown as {
      topUpRoute: { path: string; query: Record<string, string> }
    }
    expect(vm.topUpRoute).toEqual({
      path: '/send',
      query: { chainIdentifier: 'monad-regtest', to: persona(0) },
    })
    await topUp.trigger('click')
    expect(sentRaw).toEqual([])
    expect(wrapper.get('[data-testid="dapp-pool-balance"]').text()).toBe(
      '1.5 MONR',
    )

    // A new burner is topped up at its own address.
    await wrapper.get('[data-testid="dapp-create-burner-btn"]').trigger('click')
    await flushPromises()
    expect(vm.topUpRoute.query.to).toBe(persona(1))
    expect(wrapper.find('[data-testid="dapp-persona-card"]').text()).toContain(
      "m/1785'/60'/0'/1'",
    )
    expect(wrapper.emitted('create-burner')).toHaveLength(1)
    wrapper.unmount()
  })

  it('sweeps back the exact reviewed amount, signed for this network, only after confirmation', async () => {
    chainBalances.set(persona(0).toLowerCase(), 2n * ONE)
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="dapp-sweep-back-btn"]').trigger('click')
    await flushPromises()
    const fee = 21_000n * 1_000_000_000n
    const review = wrapper.get('[data-testid="dapp-sweep-review"]')
    expect(review.text()).toContain('Send 1.9999 MONR')
    expect(review.text()).toContain('0.000021 MONR')
    expect(sentRaw).toEqual([])

    await wrapper.get('[data-testid="dapp-sweep-confirm-btn"]').trigger('click')
    await flushPromises()
    expect(sentRaw).toHaveLength(1)
    const sent = Transaction.from(sentRaw[0])
    // Regtest's own native chain ID from the registry, never another network's.
    expect(sent.chainId).toBe(20143n)
    expect(sent.to?.toLowerCase()).toBe(WALLET_ADDRESS)
    expect(sent.from).toBe(persona(0))
    expect(sent.value).toBe(2n * ONE - fee)
    expect(
      wrapper.get('[data-testid="dapp-funding-message"]').text(),
    ).toContain('Sent')
    expect(wrapper.emitted('sweep-to-pool')).toHaveLength(1)
    wrapper.unmount()
  })

  it('says why a sweep failed instead of pretending it moved', async () => {
    chainBalances.set(persona(0).toLowerCase(), ONE)
    refuseSend = 'insufficient funds for gas'
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('[data-testid="dapp-sweep-back-btn"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="dapp-sweep-confirm-btn"]').trigger('click')
    await flushPromises()
    const message = wrapper.get('[data-testid="dapp-funding-message"]')
    expect(message.classes()).toContain('text-negative')
    expect(message.text()).toContain('insufficient funds for gas')
    expect(wrapper.get('[data-testid="dapp-persona-balance"]').text()).toBe(
      '1 MONR',
    )
    expect(wrapper.emitted('sweep-to-pool')).toBeUndefined()

    // Nothing to sweep is said, and nothing is signed.
    chainBalances.set(persona(0).toLowerCase(), 0n)
    await wrapper.get('[data-testid="dapp-sweep-back-btn"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="dapp-sweep-review"]').exists()).toBe(
      false,
    )
    expect(
      wrapper.get('[data-testid="dapp-funding-message"]').text(),
    ).toContain('nothing to sweep')
    wrapper.unmount()
  })

  it('offers no funding on a network personas cannot use, and no balance from another network', async () => {
    mockHostRelay = ''
    const wrapper = mountPanel()
    await flushPromises()
    expect(
      wrapper.find('[data-testid="dapp-funding-unsupported"]').exists(),
    ).toBe(true)
    expect(
      wrapper.get('[data-testid="dapp-topup-persona-btn"]').attributes('to'),
    ).toBeUndefined()
    expect(mockFetch).not.toHaveBeenCalled()
    wrapper.unmount()
    mockHostRelay = RELAY
    const solana = mountPanel({ chainIdentifier: 'solana-devnet' })
    await flushPromises()
    expect(
      solana.find('[data-testid="dapp-funding-unsupported"]').exists(),
    ).toBe(true)
    expect(mockFetch).not.toHaveBeenCalled()
    solana.unmount()
  })

  it('offers only Reject for signing and transaction requests: Frank has no website signer', async () => {
    const wrapper = mountPanel({
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

    expect(wrapper.find('[data-testid="dapp-approve-btn"]').exists()).toBe(
      false,
    )
    await wrapper.find('[data-testid="dapp-reject-btn"]').trigger('click')
    expect(wrapper.find('[data-testid="dapp-pool-balance"]').text()).toBe(
      '1.5 MONR',
    )

    // Next approval in queue is now shown
    expect(wrapper.find('[data-testid="dapp-approval-card"]').text()).toContain(
      'https://opensea.io',
    )
    expect(wrapper.find('[data-testid="dapp-approve-btn"]').exists()).toBe(
      false,
    )
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
    ).toContain('Sync this account')
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
    expect(
      wrapper.get('[data-testid="dapp-sync-account-btn"]').attributes('to'),
    ).toBe('/account-sync/send')
    expect(wrapper.emitted('wc-connect')).toBeUndefined()
    wrapper.unmount()
  })

  it('automatically discovers used burner personas on-chain and provides a dropdown selector', async () => {
    const { discoverUsedPersonasOnChain } = await import(
      './DappBridgePanel.vue'
    )

    const slotAddresses = Array.from(
      { length: 11 },
      (_, slot) =>
        deriveDappPersona(testMaster, { kind: 'shared', slot }).address,
    )
    const burner2Address = slotAddresses[2].toLowerCase()

    const discoveryFetch = jest.fn(async (_url: string, init?: RequestInit) => {
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
        if (
          addr === burner2Address &&
          item.method === 'eth_getTransactionCount'
        ) {
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
      rpcUrl: RPC,
      fetchImpl: discoveryFetch as unknown as typeof fetch,
      gapLimit: 3,
    })

    const burner2Entry = discovered.find(item => item.index === 2)
    expect(burner2Entry).toBeDefined()
    expect(burner2Entry?.used).toBe(true)
    expect(burner2Entry?.balanceWei).toBe(2_500_000_000_000_000_000n)
    expect(burner2Entry?.txCount).toBe(3)

    const wrapper = mountPanel()
    await wrapper
      .find('[data-testid="dapp-create-burner-btn"]')
      .trigger('click')
    await wrapper
      .find('[data-testid="dapp-create-burner-btn"]')
      .trigger('click')

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
