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
  it("returns the addresses of the chain's own network, or throws when none is deployed there", async () => {
    const { createEvmChain } = await import('./monad-chain')
    const { PROTOCOL_CHAINS } = await import('./chains-registry')
    const chain = createEvmChain({
      relayBaseUrl: 'http://127.0.0.1:8098',
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 10143,
      chainIdentifier: 'monad-testnet',
      networkTag: 'MONT',
      isTestnet: true,
    } as any)
    const contracts = PROTOCOL_CHAINS['monad-testnet'].contracts
    if (contracts) {
      expect(chain.getHtlcAddress()).toBe(contracts.htlc)
      expect(chain.getStateChannelAddress()).toBe(contracts.stateChannel)
    } else {
      expect(() => chain.getHtlcAddress()).toThrow(
        'GenericHTLC is not deployed on monad-testnet',
      )
      expect(() => chain.getStateChannelAddress()).toThrow(
        'StateChannel is not deployed on monad-testnet',
      )
    }
  })

  it('throws a clear error if network does not support the requested contract', async () => {
    const { createEvmChain } = await import('./monad-chain')
    const unsupportedChain = createEvmChain({
      relayBaseUrl: 'http://127.0.0.1:8098',
      rpcUrl: 'http://127.0.0.1:8545',
      chainId: 99999,
      networkTag: 'UNSUPPORTED_TAG',
      isTestnet: false,
    } as any)

    expect(() => unsupportedChain.getStateChannelAddress()).toThrow(
      'Unknown chain identifier "UNSUPPORTED_TAG"',
    )
    expect(() => unsupportedChain.getHtlcAddress()).toThrow(
      'Unknown chain identifier "UNSUPPORTED_TAG"',
    )
  })
})
