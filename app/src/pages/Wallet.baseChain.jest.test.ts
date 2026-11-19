/** @jest-environment jsdom */

/**
 * The Wallet page when the host configures Lotus v2 as the account's main balance
 * (QCLI_FRANK_BASE_CHAIN=lotus-v2-regtest, accounts/base-wallet.ts): `/wallet` is the Lotus
 * wallet, its receive address and History come from the session's Lotus wallet (opened through
 * `openUtxoWallet`, as Send and the balance open it), and Send goes to its canonical network.
 * The messaging chain (Monad) is not consulted for any of it.
 */
import { enableAutoUnmount, shallowMount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'
import type { NativeTransferRecord } from '@frank/wallet/chain'

enableAutoUnmount(afterEach)

const LOTUS = 'lotus-v2-regtest'
const ADDRESS =
  'rxpi1pl8e2pv6n7jp0g9fgrk36qzff6z98mxnynqz57hhkvga4tq8xqlmsq2859j5u'
const TXID_SENT = 'aa'.repeat(32)
const TXID_IN = 'bb'.repeat(32)

jest.mock('src/accounts/base-wallet', () => ({
  BASE_CHAIN_SETTING: 'QCLI_FRANK_BASE_CHAIN',
  MAIN_WALLET_CHAIN: jest
    .requireActual('@frank/wallet/chain/chains-registry')
    .getChainRegistryEntry('lotus-v2-regtest'),
}))

const mockTransfers = jest.fn(
  async (): Promise<readonly NativeTransferRecord[]> => [
    {
      direction: 'received',
      txid: TXID_IN,
      value: 6_000_000n,
      state: 'confirmed',
      height: 150,
    },
    {
      direction: 'sent',
      txid: TXID_SENT,
      value: 2_000_000n,
      fee: 340n,
      recipient: ADDRESS,
      state: 'pending',
      recordedAt: 1,
    },
  ],
)
const mockOpenUtxoWallet = jest.fn(async (chainIdentifier: string) => ({
  chain: {
    chainIdentifier,
    unit: 'rXPI',
    toDisplayAmount: (value: bigint) => (Number(value) / 1e6).toString(),
  },
  wallet: {
    chainIdentifier,
    localReceiveAddress: () => ({ raw: ADDRESS }),
    getReceiveAddress: async () => ({ raw: ADDRESS }),
    getNativeTransfers: mockTransfers,
  },
}))
jest.mock('src/accounts/utxo-wallets', () => ({
  openUtxoWallet: (chainIdentifier: string) =>
    mockOpenUtxoWallet(chainIdentifier),
}))
const mockGetChainAddress = jest.fn(async () => '0xmessaging')
jest.mock('../accounts/session', () => ({
  accountStatus: jest
    .requireActual('vue')
    .reactive({ status: 'ready', revision: 1 }),
  accountSession: {
    getChainAddress: () => mockGetChainAddress(),
    getCachedChainAddress: () => undefined,
  },
}))
const mockUseActiveWallet = jest.fn()
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => mockUseActiveWallet(),
}))
jest.mock('src/composables/useBalance', () => ({
  useBalance: () => ({
    parts: ref(null),
    availableSupported: ref(false),
    availableLoaded: ref(false),
    availableError: ref(false),
    formattedSpendable: ref(''),
    exactSpendable: ref(''),
    chainUnreachable: ref(false),
  }),
}))
const mockRequestedChains: string[] = []
jest.mock('src/composables/useChainBalance', () => ({
  useChainBalance: (chain: { value: string }) => {
    mockRequestedChains.push(chain.value)
    return {
      refreshCordoned: () => undefined,
      tokens: ref([]),
      tokenObservation: ref(undefined),
      presentation: ref({
        status: 'available',
        observation: { balance: 4_000_000n, formattedBalance: '4 rXPI' },
      }),
    }
  },
}))
jest.mock('src/composables/useEvmTokenBalances', () => ({
  useEvmTokenBalances: () => ({
    rows: ref([]),
    status: ref('available'),
    refresh: jest.fn(),
  }),
}))
jest.mock('src/swap/useSwapActivity', () => ({
  useSwapActivity: () => ({ rows: ref([]) }),
}))
jest.mock('src/stores/oracle', () => ({
  useSafeOracleStore: () => ({
    formatAvuAmount: () => '',
    formatUnitRate: () => '',
  }),
}))
const mockRouterPush = jest.fn()
jest.mock('vue-router', () => ({
  useRouter: () => ({ push: mockRouterPush, replace: jest.fn() }),
  useRoute: () => ({ query: {}, path: '/wallet', params: {} }),
}))
jest.mock('quasar', () => ({ copyToClipboard: jest.fn() }))
jest.mock('src/utils/notifications', () => ({
  addressCopiedNotify: jest.fn(),
  errorNotify: jest.fn(),
}))

import Wallet from './Wallet.vue'
import NativeTransferHistory from '../components/wallet/NativeTransferHistory.vue'
import { MAIN_WALLET_ID, MESSAGING_WALLET_ID } from '../utils/wallet-configs'

async function flush() {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await nextTick()
}

function mountWallet() {
  return shallowMount(Wallet, {
    global: {
      provide: {
        _q_: {
          dark: { isActive: false },
          lang: { rtl: false },
          platform: { is: {} },
        },
      },
      mocks: {
        $t: (key: string, params?: Record<string, unknown>) =>
          params ? `${key}:${JSON.stringify(params)}` : key,
      },
      stubs: {
        NativeTransferHistory: false,
        AddressText: {
          props: ['address'],
          template: '<span>{{ address }}</span>',
        },
        QInput: {
          props: ['modelValue'],
          template:
            '<div data-testid="wallet-address">{{ modelValue }}<slot name="append" /></div>',
        },
        QBtn: {
          props: ['disable', 'label'],
          template: '<button :disabled="disable">{{ label }}<slot /></button>',
        },
        ...Object.fromEntries(
          [
            'q-header',
            'q-toolbar',
            'q-toolbar-title',
            'q-page-container',
            'q-page',
            'q-scroll-area',
            'q-card',
            'q-card-section',
            'q-card-actions',
            'q-separator',
            'q-badge',
            'q-skeleton',
            'q-tabs',
            'q-tab',
            'q-tab-panels',
            'q-tab-panel',
            'q-tooltip',
            'q-icon',
            'q-list',
            'q-item',
            'q-item-section',
            'q-item-label',
            'q-banner',
            'q-avatar',
          ].map(n => [n, { template: '<div><slot /></div>' }]),
        ),
      },
    },
  })
}

describe('Wallet page with Lotus v2 as the main balance', () => {
  beforeEach(() => {
    mockOpenUtxoWallet.mockClear()
    mockGetChainAddress.mockClear()
    mockUseActiveWallet.mockReset()
    mockRouterPush.mockReset()
    mockRequestedChains.length = 0
  })

  it('composes the main wallet as the configured network, with Monad kept for messaging', () => {
    expect(MAIN_WALLET_ID).toBe(LOTUS)
    expect(MESSAGING_WALLET_ID).toBe('monad')
  })

  it('shows the Lotus balance, receive address and History; Send opens the Lotus network', async () => {
    const wrapper = mountWallet()
    await flush()
    expect(mockRequestedChains).toContain(LOTUS)
    expect(wrapper.get('[data-testid="wallet-name-text"]').text()).toBe(
      'walletPanel.mainWallet',
    )
    expect(wrapper.get('[data-testid="wallet-unit"]').text()).toBe('(rXPI)')
    expect(wrapper.get('[data-testid="wallet-balance"]').text()).toBe('4 rXPI')
    expect(mockOpenUtxoWallet).toHaveBeenCalledWith(LOTUS)
    expect(wrapper.get('[data-testid="wallet-address"]').text()).toContain(
      ADDRESS,
    )
    // Nothing of the messaging chain's wallet is read for the main balance's page.
    expect(mockGetChainAddress).not.toHaveBeenCalled()
    expect(mockUseActiveWallet).not.toHaveBeenCalled()

    const history = wrapper.getComponent(NativeTransferHistory)
    expect(history.props('chainIdentifier')).toBe(LOTUS)
    const rows = history.findAll('[data-testid="native-transfer-row"]')
    // Pending send first, then the confirmed receipt.
    expect(rows.map(row => row.attributes('data-direction'))).toEqual([
      'sent',
      'received',
    ])
    expect(rows[0]!.get('[data-testid="native-transfer-amount"]').text()).toBe(
      '-2 rXPI',
    )
    expect(rows[0]!.get('[data-testid="native-transfer-status"]').text()).toBe(
      'walletHistory.nativeTransfer.status.pending',
    )
    expect(rows[0]!.text()).toContain(ADDRESS)
    expect(rows[1]!.get('[data-testid="native-transfer-amount"]').text()).toBe(
      '+6 rXPI',
    )
    expect(rows[1]!.get('[data-testid="native-transfer-block"]').text()).toBe(
      'walletHistory.nativeTransfer.inBlock:{"height":150}',
    )

    await wrapper.get('[data-testid="wallet-send-action"]').trigger('click')
    expect(mockRouterPush).toHaveBeenCalledWith(
      `/send?chainIdentifier=${LOTUS}`,
    )
  })

  it('keeps the last rows and says so when a History read fails', async () => {
    const wrapper = mountWallet()
    await flush()
    mockTransfers.mockRejectedValueOnce(new Error('relay down'))
    const vm = wrapper.vm as unknown as { activeTab: string }
    vm.activeTab = 'history'
    await flush()
    const history = wrapper.getComponent(NativeTransferHistory)
    expect(
      history.find('[data-testid="native-transfer-unavailable"]').exists(),
    ).toBe(true)
    expect(history.findAll('[data-testid="native-transfer-row"]')).toHaveLength(
      2,
    )
  })
})
