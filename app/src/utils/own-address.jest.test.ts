import { activeChain } from '@frank/wallet/chain'
import {
  getOwnCanonicalAddress,
  isOwnAddress,
  resolveOwnAddress,
} from './own-address'

// Only the wallet handle is faked; the lazy import, parse and format are the real ones.
const mockUseActiveWallet = jest.fn()
jest.mock('src/composables/useActiveWallet', () => ({
  useActiveWallet: () => mockUseActiveWallet(),
}))

const OWN = '0x3e3e3e3e3e3E3E3E3e3e3E3E3e3e3E3E3e3E3E3e'
const OTHER = '0x1111111111111111111111111111111111111111'
const canonicalOwn = activeChain.formatAddress(
  activeChain.parseAddress(OWN) as never,
)

describe('utils/own-address.ts', () => {
  let consoleError: jest.SpyInstance
  beforeEach(() => {
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
})
