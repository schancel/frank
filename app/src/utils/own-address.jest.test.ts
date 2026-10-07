import { activeChain } from '@frank/wallet/chain'
import { effectScope, reactive } from 'vue'
import {
  getOwnCanonicalAddress,
  isOwnAddress,
  resolveOwnAddress,
  resolveOwnAddresses,
  sameCanonicalAddress,
  useReactiveOwnCanonicalAddress,
  useReactiveOwnAddresses,
  notifyOwnAddressesChanged,
  isKnownOwnAddress,
} from './own-address'

// Only the wallet handle is faked; the lazy import, parse and format are the real ones.
const mockUseActiveWallet = jest.fn()
let mockAccountStatus: { revision: number; status: string }
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => mockUseActiveWallet(),
}))
jest.mock('../accounts/session', () => ({
  get accountStatus() {
    return mockAccountStatus
  },
}))

const OWN = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const OTHER = '0x1111111111111111111111111111111111111111'
const canonicalOwn = activeChain.formatAddress(
  activeChain.parseAddress(OWN) as never,
)

describe('utils/own-address.ts', () => {
  let consoleError: jest.SpyInstance
  beforeEach(() => {
    mockAccountStatus = reactive({ revision: 1, status: 'ready' })
    mockUseActiveWallet.mockReset()
    mockUseActiveWallet.mockResolvedValue({
      identity: { address: { raw: OWN } },
    })
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined)
  })
  afterEach(() => consoleError.mockRestore())

  it('resolves the wallet identity to the canonical address', async () => {
    expect(await resolveOwnAddress()).toEqual({ address: canonicalOwn })
    expect(await getOwnCanonicalAddress()).toBe(canonicalOwn)
  })

  it.each([
    ['checksum form', OWN],
    ['lowercase', OWN.toLowerCase()],
    ['padded', `  ${OWN.toLowerCase()}  `],
  ])('recognizes the own address as %s', async (_label, spelling) => {
    expect(await isOwnAddress(spelling)).toBe(true)
  })

  it('does not treat a different or unparseable address as own', async () => {
    expect(await isOwnAddress(OTHER)).toBe(false)
    expect(await isOwnAddress('not-an-address')).toBe(false)
  })

  it('compares accepted route spellings canonically', () => {
    expect(sameCanonicalAddress(OWN, OWN.toLowerCase())).toBe(true)
    expect(sameCanonicalAddress(OWN, OTHER)).toBe(false)
    expect(sameCanonicalAddress(OWN, 'not-an-address')).toBe(false)
  })

  it('fails open, without an error, when the wallet is unavailable', async () => {
    mockUseActiveWallet.mockRejectedValue(new Error('wallet not initialized'))
    expect(await resolveOwnAddress()).toEqual({ address: null })
    expect(await isOwnAddress(OWN)).toBe(false)
    expect(consoleError).not.toHaveBeenCalled()
  })

  it('fails open but observably when the wallet handle has the wrong shape', async () => {
    mockUseActiveWallet.mockResolvedValue({
      identiti: { address: { raw: OWN } },
    })

    const result = await resolveOwnAddress()

    expect(result.address).toBeNull()
    expect(result.error).toBeInstanceOf(Error)
    expect(consoleError).toHaveBeenCalled()
    expect(await isOwnAddress(OWN)).toBe(false)
  })

  it('clears synchronously on session revision change and ignores a stale address resolution', async () => {
    const replacement = activeChain.formatAddress(
      activeChain.parseAddress(OTHER) as never,
    )
    let resolveFirst: ((wallet: unknown) => void) | undefined
    let resolveSecond: ((wallet: unknown) => void) | undefined
    mockUseActiveWallet
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveFirst = resolve
        }),
      )
      .mockReturnValueOnce(
        new Promise(resolve => {
          resolveSecond = resolve
        }),
      )
    const scope = effectScope()
    const address = scope.run(() => useReactiveOwnCanonicalAddress())!
    await Promise.resolve()
    mockAccountStatus.revision = 2
    expect(address.value).toBeNull()
    await Promise.resolve()
    resolveSecond?.({ identity: { address: { raw: OTHER } } })
    await Promise.resolve()
    await Promise.resolve()
    expect(address.value).toBe(replacement)
    resolveFirst?.({ identity: { address: { raw: OWN } } })
    await Promise.resolve()
    await Promise.resolve()
    expect(address.value).toBe(replacement)
    scope.stop()
  })

  it('resolves all addresses including sub-account pool, change pool, and stealth keyring (#1071)', async () => {
    const SUB1 = '0xeddad90000000000000000000000000093b169'
    const SUB2 = '0x1e6fb5000000000000000000000000003df7bd'
    const CHANGE1 = '0x2222222222222222222222222222222222222222'
    const STEALTH1 = '0x3333333333333333333333333333333333333333'
    const RECV = '0x4444444444444444444444444444444444444444'

    mockUseActiveWallet.mockResolvedValue({
      identity: { address: { raw: OWN } },
      getReceiveAddress: async () => ({ raw: RECV }),
      pool: {
        records: () => [
          { index: 0, address: SUB1, status: 'spent' },
          { index: 1, address: SUB2, status: 'spent' },
        ],
      },
      changePool: {
        records: () => [{ index: 0, address: CHANGE1 }],
      },
      stealthKeyring: {
        getAccounts: () => [{ address: STEALTH1 }],
      },
    })

    const addresses = await resolveOwnAddresses()
    expect(isKnownOwnAddress(OWN, addresses)).toBe(true)
    expect(isKnownOwnAddress(SUB1, addresses)).toBe(true)
    expect(isKnownOwnAddress(SUB2, addresses)).toBe(true)
    expect(isKnownOwnAddress(CHANGE1, addresses)).toBe(true)
    expect(isKnownOwnAddress(STEALTH1, addresses)).toBe(true)
    expect(isKnownOwnAddress(RECV, addresses)).toBe(true)
    expect(isKnownOwnAddress(OTHER, addresses)).toBe(false)
  })

  it('isKnownOwnAddress handles case differences and whitespace', () => {
    const list = ['0xeddad90000000000000000000000000093b169']
    expect(
      isKnownOwnAddress('0xEDDAD90000000000000000000000000093B169', list),
    ).toBe(true)
    expect(
      isKnownOwnAddress('  0xeddad90000000000000000000000000093b169  ', list),
    ).toBe(true)
    expect(isKnownOwnAddress(null, list)).toBe(false)
    expect(isKnownOwnAddress('', list)).toBe(false)
    expect(isKnownOwnAddress('0xother', list)).toBe(false)
  })

  it('updates reactive own addresses when notifyOwnAddressesChanged is called', async () => {
    const SUB = '0xeddad90000000000000000000000000093b169'
    let currentSubAccounts: {
      index: number
      address: string
      status: string
    }[] = []
    mockUseActiveWallet.mockImplementation(async () => ({
      identity: { address: { raw: OWN } },
      pool: { records: () => currentSubAccounts },
    }))

    const scope = effectScope()
    const addressesRef = scope.run(() => useReactiveOwnAddresses())!
    await Promise.resolve()
    await Promise.resolve()
    expect(isKnownOwnAddress(SUB, addressesRef)).toBe(false)

    // A sub-account is now leased and recorded
    currentSubAccounts = [{ index: 0, address: SUB, status: 'spent' }]
    notifyOwnAddressesChanged()
    await Promise.resolve()
    await Promise.resolve()

    expect(isKnownOwnAddress(SUB, addressesRef)).toBe(true)
    scope.stop()
  })
})
