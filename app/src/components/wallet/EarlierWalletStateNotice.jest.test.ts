/** @jest-environment jsdom */
/**
 * The notice of wallet state an earlier build wrote under another name: shown for the open
 * network's wallet when that wallet found such state at open, with the locations, and not
 * otherwise. It opens, reads and deletes nothing itself.
 */
import { flushPromises, mount } from '@vue/test-utils'
import enUS from 'src/i18n/en-us'

const mockPrimary = { chainIdentifier: 'monad-testnet', family: 'evm' }
const mockEarlier = jest.fn()
const mockOpenEvmWallet = jest.fn()
jest.mock('src/accounts/session', () => ({
  accountSession: { peekWallet: () => mockPrimary },
  accountStatus: { status: 'ready' },
}))
jest.mock('src/accounts/evm-wallets', () => ({
  openEvmWallet: (...args: unknown[]) => mockOpenEvmWallet(...args),
}))
jest.mock('src/accounts/wallet-reconcile', () => ({
  earlierStateOf: (wallet: unknown) => mockEarlier(wallet),
}))

import EarlierWalletStateNotice from './EarlierWalletStateNotice.vue'

type Messages = Record<string, unknown>
const t = (key: string): string => {
  const value = key
    .split('.')
    .reduce<unknown>((o, k) => (o as Messages | undefined)?.[k], enUS)
  return typeof value === 'string' ? value : key
}
const mountNotice = (chainIdentifier: string) =>
  mount(EarlierWalletStateNotice, {
    props: { chainIdentifier },
    global: {
      mocks: { $t: t },
      stubs: {
        QBanner: { template: '<div v-bind="$attrs"><slot /></div>' },
        QIcon: { template: '<i />' },
      },
    },
  })

beforeEach(() => {
  mockEarlier.mockReset()
  mockOpenEvmWallet.mockReset()
})

test('names the earlier locations and how to find the funds again', async () => {
  const location = 'frank-monad-wallet-state-evm-0xabc'
  mockEarlier.mockReturnValue({
    chainIdentifier: 'monad-testnet',
    location: 'frank-wallet-state-monad-testnet-evm-0xabc',
    earlierLocations: [location],
  })
  const notice = mountNotice('monad-testnet')
  await flushPromises()
  expect(mockEarlier).toHaveBeenCalledWith(mockPrimary)
  const shown = notice.find('[data-test="earlier-wallet-state"]')
  expect(shown.text()).toContain(
    'Wallet data from an earlier version is not read',
  )
  expect(shown.text()).toContain('Reconcile wallet')
  expect(
    notice
      .findAll('[data-test="earlier-wallet-state-location"]')
      .map(row => row.text()),
  ).toEqual([`level-js-${location}/…`])
})

test('shows nothing when the wallet found no earlier state', async () => {
  mockEarlier.mockReturnValue(undefined)
  const notice = mountNotice('monad-testnet')
  await flushPromises()
  expect(notice.find('[data-test="earlier-wallet-state"]').exists()).toBe(false)
})

test('asks the selected EVM network’s own wallet, not the primary one', async () => {
  const sepolia = { chainIdentifier: 'ethereum-sepolia', family: 'evm' }
  mockOpenEvmWallet.mockResolvedValue({ wallet: sepolia })
  mockEarlier.mockReturnValue(undefined)
  mountNotice('ethereum-sepolia')
  await flushPromises()
  expect(mockOpenEvmWallet).toHaveBeenCalledWith('ethereum-sepolia')
  expect(mockEarlier).toHaveBeenCalledWith(sepolia)
})
