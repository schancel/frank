/**
 * Unit tests for `utils/chain-address.ts` -- the chain-agnostic address-normalization helper used
 * as the storage key in `stores/chats.ts`/`stores/contacts.ts` (ticket #42). Mocks `activeChain`
 * (same pattern as `stores/forum.jest.test.ts`/`stores/topics.jest.test.ts`) rather than the real
 * Monad chain, since this function's own contract is "delegate to activeChain.parseAddress/
 * formatAddress, throw if parsing fails" -- not Monad-specific behavior.
 */
import {
  toChainDisplayAddress,
  safeToChainDisplayAddress,
} from './chain-address'

jest.mock('@frank/wallet/chain', () => ({
  activeChain: {
    name: 'monad',
    parseAddress: jest.fn(),
    formatAddress: jest.fn(),
  },
}))

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { activeChain } = jest.requireMock('@frank/wallet/chain')

const mockedParseAddress = activeChain.parseAddress as jest.Mock
const mockedFormatAddress = activeChain.formatAddress as jest.Mock

beforeEach(() => {
  mockedParseAddress.mockReset()
  mockedFormatAddress.mockReset()
})

describe('toChainDisplayAddress', () => {
  it('formats a successfully-parsed address via activeChain.formatAddress', () => {
    const parsed = { raw: '0xdeadbeef' }
    mockedParseAddress.mockReturnValue(parsed)
    mockedFormatAddress.mockReturnValue('0xDeadBeef')

    const result = toChainDisplayAddress('0xdeadbeef')

    expect(mockedParseAddress).toHaveBeenCalledWith('0xdeadbeef')
    expect(mockedFormatAddress).toHaveBeenCalledWith(parsed)
    expect(result).toBe('0xDeadBeef')
  })

  it('throws, naming the active chain and the offending input, when parseAddress returns undefined', () => {
    mockedParseAddress.mockReturnValue(undefined)

    expect(() => toChainDisplayAddress('not-an-address')).toThrow(
      'Invalid monad address, cannot derive a store key: not-an-address',
    )
    expect(mockedFormatAddress).not.toHaveBeenCalled()
  })
})

describe('safeToChainDisplayAddress', () => {
  it('formats a valid address safely', () => {
    const parsed = { raw: '0x1234' }
    mockedParseAddress.mockReturnValue(parsed)
    mockedFormatAddress.mockReturnValue('0x1234')

    expect(safeToChainDisplayAddress('0x1234')).toBe('0x1234')
    expect(mockedParseAddress).toHaveBeenCalledWith('0x1234')
  })

  it('returns null on falsy or unparseable address without throwing', () => {
    mockedParseAddress.mockReturnValue(undefined)

    expect(safeToChainDisplayAddress(null)).toBeNull()
    expect(safeToChainDisplayAddress(undefined)).toBeNull()
    expect(safeToChainDisplayAddress('')).toBeNull()
    expect(
      safeToChainDisplayAddress('ba3c18c2-a80d-5e5b-bd9d-fd52f5106351'),
    ).toBeNull()
  })
})
