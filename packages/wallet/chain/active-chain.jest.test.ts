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

describe('ActiveChain contract resolution', () => {
  it('resolves canonical contract addresses on MonadChain', async () => {
    const { MonadChain } = await import('./monad-chain')
    expect(MonadChain.getChannelVaultAddress()).toBe('0x720472c8ce72c2A2D711333e064ABD3E6BbEAdd3')
    expect(MonadChain.getTablePotVaultAddress()).toBe('0xe8D2A1E88c91DCd5433208d4152Cc4F399a7e91d')
    expect(MonadChain.getHtlcAddress()).toBe('0x5067457698Fd6Fa1C6964e416b3f42713513B3dD')
  })

  it('supports explicit contract overrides in createMonadChain', async () => {
    const { createMonadChain, loadMonadChainConfigFromEnv } = await import('./monad-chain')
    const custom = createMonadChain({
      ...loadMonadChainConfigFromEnv(),
      contracts: {
        channelVault: '0x1111111111111111111111111111111111111111',
        tablePotVault: '0x2222222222222222222222222222222222222222',
        htlc: '0x3333333333333333333333333333333333333333',
      },
    })
    expect(custom.getChannelVaultAddress()).toBe('0x1111111111111111111111111111111111111111')
    expect(custom.getTablePotVaultAddress()).toBe('0x2222222222222222222222222222222222222222')
    expect(custom.getHtlcAddress()).toBe('0x3333333333333333333333333333333333333333')
  })

  it('throws clear error when contract is not configured on unsupported chain', async () => {
    const { createMonadChain, loadMonadChainConfigFromEnv } = await import('./monad-chain')
    const unsupported = createMonadChain({
      ...loadMonadChainConfigFromEnv(),
      networkId: 'unsupported-network',
      contracts: {},
    })
    expect(() => unsupported.getChannelVaultAddress()).toThrow('ChannelVault contract is not available on chain unsupported-network')
    expect(() => unsupported.getTablePotVaultAddress()).toThrow('TablePotVault contract is not available on chain unsupported-network')
    expect(() => unsupported.getHtlcAddress()).toThrow('GenericHTLC contract is not available on chain unsupported-network')
  })
})
