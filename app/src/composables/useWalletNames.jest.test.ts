/** @jest-environment jsdom */
import { useWalletNames, WALLET_NAMES_STORAGE_KEY } from './useWalletNames'

describe('useWalletNames composable', () => {
  beforeEach(() => {
    localStorage.clear()
    const { clearAllCustomNames } = useWalletNames()
    clearAllCustomNames()
  })

  test('returns empty string if no custom name is set', () => {
    const { getCustomName } = useWalletNames()
    expect(getCustomName('monad')).toBe('')
    expect(getCustomName('ecash')).toBe('')
    expect(getCustomName('solana')).toBe('')
  })

  test('sets and persists custom wallet name to localStorage', () => {
    const { setCustomName, getCustomName } = useWalletNames()
    setCustomName('monad', '  Trading Bot  ')
    expect(getCustomName('monad')).toBe('Trading Bot')

    const stored = JSON.parse(
      localStorage.getItem(WALLET_NAMES_STORAGE_KEY) || '{}',
    )
    expect(stored.monad).toBe('Trading Bot')
  })

  test('setting an empty name removes the custom name', () => {
    const { setCustomName, getCustomName } = useWalletNames()
    setCustomName('monad', 'Trading Bot')
    expect(getCustomName('monad')).toBe('Trading Bot')

    setCustomName('monad', '   ')
    expect(getCustomName('monad')).toBe('')

    const stored = JSON.parse(
      localStorage.getItem(WALLET_NAMES_STORAGE_KEY) || '{}',
    )
    expect(stored.monad).toBeUndefined()
  })

  test('resetCustomName removes custom name for specified chain', () => {
    const { setCustomName, resetCustomName, getCustomName } = useWalletNames()
    setCustomName('monad', 'Trading Bot')
    setCustomName('ecash', 'Pocket Cash')

    resetCustomName('monad')
    expect(getCustomName('monad')).toBe('')
    expect(getCustomName('ecash')).toBe('Pocket Cash')

    const stored = JSON.parse(
      localStorage.getItem(WALLET_NAMES_STORAGE_KEY) || '{}',
    )
    expect(stored.monad).toBeUndefined()
    expect(stored.ecash).toBe('Pocket Cash')
  })

  test('loads stored names on initWalletNames', () => {
    localStorage.setItem(
      WALLET_NAMES_STORAGE_KEY,
      JSON.stringify({ monad: 'Vault', solana: 'DeFi Stash' }),
    )

    const { initWalletNames, getCustomName } = useWalletNames()
    initWalletNames()
    expect(getCustomName('monad')).toBe('Vault')
    expect(getCustomName('solana')).toBe('DeFi Stash')
  })

  test('handles localStorage exceptions gracefully', () => {
    const getItemSpy = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('Access denied')
      })
    const setItemSpy = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Quota exceeded')
      })

    const { setCustomName, getCustomName, initWalletNames } = useWalletNames()
    expect(() => initWalletNames()).not.toThrow()
    expect(() => setCustomName('monad', 'Bot')).not.toThrow()
    expect(getCustomName('monad')).toBe('Bot')

    getItemSpy.mockRestore()
    setItemSpy.mockRestore()
  })
})
