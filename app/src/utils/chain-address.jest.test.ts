/**
 * Unit tests for `utils/chain-address.ts` -- the chain-agnostic address-normalization helper used
 * as the storage key in `stores/chats.ts`/`stores/contacts.ts` (ticket #42). Mocks `activeChain`
 * (same pattern as `stores/forum.jest.test.ts`/`stores/topics.jest.test.ts`) rather than the real
 * Monad chain, since this function's own contract is "delegate to activeChain.parseAddress/
 * formatAddress, throw if parsing fails" -- not Monad-specific behavior.
 */
  isChainAddress,
  safeChainDisplayAddress,
  safeToChainDisplayAddress,
  toChainDisplayAddress,
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

describe('isChainAddress', () => {
  it('returns true when parseAddress succeeds', () => {
    mockedParseAddress.mockReturnValue({ raw: '0x123' })
    expect(isChainAddress('0x123')).toBe(true)
  })

  it('returns false when parseAddress returns undefined or input is invalid', () => {
    mockedParseAddress.mockReturnValue(undefined)
    expect(isChainAddress('not-an-address')).toBe(false)
    expect(isChainAddress('')).toBe(false)
    expect(isChainAddress(null)).toBe(false)
    expect(isChainAddress(undefined)).toBe(false)
  })
})

describe('safeChainDisplayAddress', () => {
  it('returns formatted address on valid input', () => {
    const parsed = { raw: '0x123' }
    mockedParseAddress.mockReturnValue(parsed)
    mockedFormatAddress.mockReturnValue('0x123Formatted')
    expect(safeChainDisplayAddress('0x123')).toBe('0x123Formatted')
  })

  it('returns null on invalid input or undefined', () => {
    mockedParseAddress.mockReturnValue(undefined)
    expect(safeChainDisplayAddress('bad-input')).toBeNull()
    expect(safeChainDisplayAddress('')).toBeNull()
    expect(safeChainDisplayAddress(null)).toBeNull()
  })
})
