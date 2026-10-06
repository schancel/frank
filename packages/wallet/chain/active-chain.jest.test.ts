/**
 * Unit tests for `active-chain.ts`'s `parseAddressWithOptionalRelay` (ticket #78): the pure
 * "finger"-syntax parsing helper, independent of any `ActiveChain` implementation or UI wiring
 * (neither exists for this yet -- see the file's own doc comment).
 */
import { parseAddressWithOptionalRelay } from './active-chain'

describe('parseAddressWithOptionalRelay', () => {
  it('returns just the address, unchanged, when there is no @', () => {
    expect(
      parseAddressWithOptionalRelay(
        '0x000000000000000000000000000000000000dEaD',
      ),
    ).toEqual({ address: '0x000000000000000000000000000000000000dEaD' })
  })

  it('splits on @ and defaults a bare host to https://', () => {
    expect(parseAddressWithOptionalRelay('0xabc@relay.example.com')).toEqual({
      address: '0xabc',
      relayBaseUrl: 'https://relay.example.com',
    })
  })

  it('keeps an explicit http:// scheme as-is (does not force https)', () => {
    expect(
      parseAddressWithOptionalRelay('0xabc@http://127.0.0.1:8098'),
    ).toEqual({
      address: '0xabc',
      relayBaseUrl: 'http://127.0.0.1:8098',
    })
  })

  it('keeps an explicit https:// scheme as-is', () => {
    expect(
      parseAddressWithOptionalRelay('0xabc@https://relay.example.com'),
    ).toEqual({
      address: '0xabc',
      relayBaseUrl: 'https://relay.example.com',
    })
  })

  it('splits on the last @, not the first, in case a host itself is unusual', () => {
    expect(parseAddressWithOptionalRelay('0xabc@foo@relay.example.com')).toEqual({
      address: '0xabc@foo',
      relayBaseUrl: 'https://relay.example.com',
    })
  })
})

describe('ActiveChain contract address helpers', () => {
  it('returns canonical contract addresses on MonadChain', async () => {
    const { MonadChain } = await import('./monad-chain')
    expect(MonadChain.getChannelVaultAddress()).toBe(
      '0xB0ae4A94A7616029CD99Cf3Ab9Bf417be1DfD9E9',
    )
    expect(MonadChain.getTablePotVaultAddress()).toBe(
      '0x9B7d7E260da7f3a8e92562D21551FE0d350F9C8e',
    )
    expect(MonadChain.getHtlcAddress()).toBe(
      '0x91883414DaDF6f18f3d14E3de3a31BfC833e6bB6',
    )
  })

  it('throws a clear error if network does not support the requested contract', async () => {
    const { createMonadChain } = await import('./monad-chain')
    const unsupportedChain = createMonadChain({
      relayBaseUrl: 'http://127.0.0.1:8098',
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 99999,
      networkTag: 'UNSUPPORTED_TAG',
      isTestnet: false,
    } as any)

    expect(() => unsupportedChain.getChannelVaultAddress()).toThrow(
      'ChannelVault contract is not configured for network UNSUPPORTED_TAG',
    )
    expect(() => unsupportedChain.getTablePotVaultAddress()).toThrow(
      'TablePotVault contract is not configured for network UNSUPPORTED_TAG',
    )
    expect(() => unsupportedChain.getHtlcAddress()).toThrow(
      'GenericHTLC contract is not configured for network UNSUPPORTED_TAG',
    )
  })
})
