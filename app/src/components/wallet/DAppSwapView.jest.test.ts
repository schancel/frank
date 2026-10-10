/** @jest-environment jsdom */
/**
 * The swap shell decides one thing: which chain family's panel a wallet gets, or that it gets
 * none. The panels have their own tests.
 */
import { enableAutoUnmount, mount } from '@vue/test-utils'
import en from '../../i18n/en-us'
import fr from '../../i18n/fr-fr'
import { WALLET_CONFIGS } from '../../utils/wallet-configs'

enableAutoUnmount(afterEach)

const mockChainFor = jest.fn<string | undefined, [string, boolean]>()
jest.mock('src/utils/native-transfer', () => ({
  nativeSendChainIdentifier: (wallet: string, isTestnet: boolean) =>
    mockChainFor(wallet, isTestnet),
}))
const mockExtraVenues: { id: string; protocol: string; displayName: string }[] =
  []
jest.mock('src/swap/evm-swap-session', () => {
  const { listEvmSwapVenues } = jest.requireActual(
    '@frank/wallet/chain/dex-deployments',
  )
  return {
    evmSwapVenues: (id: string | undefined) => {
      const configured = id ? listEvmSwapVenues(id) : []
      return configured.length ? [...configured, ...mockExtraVenues] : []
    },
  }
})

import DAppSwapView from './DAppSwapView.vue'

const translate = (locale: typeof en | typeof fr) => (key: string) =>
  key
    .split('.')
    .reduce<unknown>(
      (value, part) =>
        value && typeof value === 'object'
          ? (value as Record<string, unknown>)[part]
          : undefined,
      locale,
    ) ?? key
const panel = (name: string, props: string[]) => ({
  name,
  props,
  template: `<div data-testid="${name}">{{ JSON.stringify($props) }}</div>`,
})
function mountShell(
  wallet: string,
  options: { isTestnet?: boolean; locale?: typeof en | typeof fr } = {},
) {
  return mount(DAppSwapView, {
    props: { selectedWallet: wallet, isTestnet: options.isTestnet ?? true },
    global: {
      mocks: { $t: translate(options.locale ?? en) },
      stubs: {
        EvmSwapPanel: panel('evm-panel', [
          'chainIdentifier',
          'walletId',
          'venueId',
        ]),
        QBtn: {
          props: ['label'],
          template: '<button>{{ label }}</button>',
        },
        SolanaSwapPanel: panel('solana-panel', []),
        QCard: { template: '<div><slot /></div>' },
        QCardSection: { template: '<div><slot /></div>' },
      },
    },
  })
}
const has = (view: ReturnType<typeof mountShell>, id: string) =>
  view.find(`[data-testid="${id}"]`).exists()

beforeEach(() => {
  mockExtraVenues.length = 0
  mockChainFor.mockReset()
  mockChainFor.mockImplementation((wallet, isTestnet) =>
    wallet === 'monad'
      ? isTestnet
        ? 'monad-testnet'
        : 'monad-mainnet'
      : wallet === 'solana'
      ? 'solana-devnet'
      : undefined,
  )
})

describe('the swap shell', () => {
  it('gives the Monad testnet wallet the EVM panel, bound to its canonical chain', () => {
    const view = mountShell('monad')
    expect(JSON.parse(view.get('[data-testid="evm-panel"]').text())).toEqual({
      chainIdentifier: 'monad-testnet',
      walletId: 'monad',
      venueId: 'uniswap-v4',
    })
    // One venue: nothing to choose.
    expect(has(view, 'swap-venue-choice')).toBe(false)
    expect(has(view, 'solana-panel')).toBe(false)
    expect(has(view, 'swap-unavailable')).toBe(false)
  })

  it('gives a Solana wallet the Solana panel and never the EVM one', () => {
    const view = mountShell('solana')
    // The Solana panel finds its own wallet: the shell passes it nothing.
    expect(JSON.parse(view.get('[data-testid="solana-panel"]').text())).toEqual(
      {},
    )
    expect(has(view, 'evm-panel')).toBe(false)
  })

  it('does not offer a swap on a network with no confirmed deployment, mainnet included', () => {
    const view = mountShell('monad', { isTestnet: false })
    expect(has(view, 'evm-panel')).toBe(false)
    expect(view.get('[data-testid="swap-unavailable"]').text()).toContain(
      en.swap.unavailableNetwork,
    )
  })

  it.each(
    WALLET_CONFIGS.map(wallet => wallet.id).filter(
      id => id !== 'monad' && id !== 'solana',
    ),
  )('says truthfully that the %s wallet has no swap', wallet => {
    const view = mountShell(wallet)
    expect(has(view, 'evm-panel')).toBe(false)
    expect(has(view, 'solana-panel')).toBe(false)
    expect(view.text()).toContain(en.walletPanel.swapUnavailable)
    expect(view.text()).toContain(en.swap.unavailableNetwork)
    expect(view.find('button').exists()).toBe(false)
    expect(has(view, 'swap-venue-choice')).toBe(false)
  })

  it('says it in French too', () => {
    const view = mountShell('ecash', { locale: fr })
    expect(view.text()).toContain(fr.walletPanel.swapUnavailable)
    expect(view.text()).toContain(fr.swap.unavailableNetwork)
  })

  it('follows the selected wallet', async () => {
    const view = mountShell('ecash')
    expect(has(view, 'swap-unavailable')).toBe(true)
    await view.setProps({ selectedWallet: 'monad' })
    expect(has(view, 'evm-panel')).toBe(true)
    await view.setProps({ selectedWallet: 'solana' })
    expect(has(view, 'solana-panel')).toBe(true)
    expect(has(view, 'evm-panel')).toBe(false)
  })

  it('lets the user pick when a chain has more than one venue, and opens on the first', async () => {
    // A second venue of the same protocol, as configuration would list it.
    mockExtraVenues.push({
      id: 'second',
      protocol: 'uniswap-v4',
      displayName: 'Second venue',
    })
    const view = mountShell('monad')
    expect(view.get('[data-testid="swap-venue-choice"]').text()).toContain(
      'Uniswap v4',
    )
    expect(
      JSON.parse(view.get('[data-testid="evm-panel"]').text()).venueId,
    ).toBe('uniswap-v4')
    await view.get('[data-testid="swap-venue-second"]').trigger('click')
    expect(
      JSON.parse(view.get('[data-testid="evm-panel"]').text()).venueId,
    ).toBe('second')
    // Another wallet starts from its own first venue, not from this choice.
    await view.setProps({ selectedWallet: 'ecash' })
    expect(has(view, 'swap-venue-choice')).toBe(false)
  })
})
