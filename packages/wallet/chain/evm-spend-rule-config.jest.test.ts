/**
 * A network's spend rule is a protocol fact of its registry row. An EVM wallet configuration that
 * leaves it out, or states it differently, is refused when the chain is created: signed without
 * it, transfers at consecutive nonces are mined and reverted (what the composed swap livecheck
 * did on Monad testnet with a hand-built configuration).
 */
import { createEvmChain, loadMonadChainConfigFromEnv } from './evm-chain'
import type { EvmChainConfig } from './evm-chain-config'
import { getChainRegistryEntry } from './chains-registry'
import { registrySpendRule, requireRegistrySpendRule } from './evm-spend-rule'

const base: EvmChainConfig = {
  networkId: 'monad-testnet',
  rpcChain: 'monad-testnet',
  chainId: 10143,
  relayBaseUrl: 'https://relay.example',
  networkTag: 'MONT',
  stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
  defaultTopicVoteValueWei: 1_000n,
  subAccountPoolSize: 0,
  walletStorageLocation: false,
}

describe('the spend rule an EVM wallet signs with comes from the registry', () => {
  it('reads the Monad rule from the registry row', () => {
    const entry = getChainRegistryEntry('monad-testnet')!
    expect(registrySpendRule('monad-testnet')).toEqual({
      spendSpacingBlocks: entry.spendSpacingBlocks,
      spendRuleHead: entry.spendRuleHead,
      reserveBalanceWei: BigInt(entry.reserveBalanceWei!),
    })
    expect(registrySpendRule('monad-testnet').spendSpacingBlocks).toBeGreaterThan(0)
    // A network without one has none; an unknown network has none to give.
    expect(registrySpendRule('ethereum-sepolia')).toEqual({})
    expect(registrySpendRule('no-such-network')).toEqual({})
  })

  it('refuses a configuration that leaves the rule out', () => {
    expect(() => createEvmChain(base)).toThrow(
      /EVM spend rule mismatch for monad-testnet: spendSpacingBlocks is absent/,
    )
  })

  it('refuses a configuration that states any part of the rule differently', () => {
    const rule = registrySpendRule('monad-testnet')
    for (const contradiction of [
      { spendSpacingBlocks: rule.spendSpacingBlocks! - 1 },
      { spendRuleHead: 'latest' as const },
      { reserveBalanceWei: rule.reserveBalanceWei! / 10n },
      { spendSpacingBlocks: undefined },
    ])
      expect(() => createEvmChain({ ...base, ...rule, ...contradiction })).toThrow(
        /EVM spend rule mismatch for monad-testnet/,
      )
  })

  it('refuses a rule stated for a network whose row has none', () => {
    expect(() =>
      requireRegistrySpendRule('ethereum-sepolia', { spendSpacingBlocks: 3 }),
    ).toThrow(/EVM spend rule mismatch for ethereum-sepolia/)
    expect(() => requireRegistrySpendRule('ethereum-sepolia', {})).not.toThrow()
  })

  it('accepts the registry rule, as the app and loadMonadChainConfigFromEnv take it', () => {
    expect(() => createEvmChain({ ...base, ...registrySpendRule('monad-testnet') })).not.toThrow()
    const fromEnv = loadMonadChainConfigFromEnv({ isTestnet: true })
    expect({
      spendSpacingBlocks: fromEnv.spendSpacingBlocks,
      spendRuleHead: fromEnv.spendRuleHead,
      reserveBalanceWei: fromEnv.reserveBalanceWei,
    }).toEqual(registrySpendRule('monad-testnet'))
    expect(() => createEvmChain({ ...fromEnv, walletStorageLocation: false })).not.toThrow()
  })

  it('taken over a configuration built for Monad, gives a peer chain its own rule, never Monad’s', () => {
    const sepolia = getChainRegistryEntry('ethereum-sepolia')!
    const peer = {
      ...loadMonadChainConfigFromEnv({ isTestnet: true }),
      walletStorageLocation: false as const,
      chainIdentifier: sepolia.id,
      networkId: sepolia.id,
      rpcChain: sepolia.id,
      chainId: BigInt(sepolia.nativeChainId!),
      networkTag: sepolia.networkTag!,
    }
    // Monad's rule carried along is refused: Sepolia's row has none.
    expect(() => createEvmChain(peer)).toThrow(/EVM spend rule mismatch for ethereum-sepolia/)
    const own = { ...peer, ...registrySpendRule(sepolia.id) }
    expect(own.spendSpacingBlocks).toBeUndefined()
    expect(own.spendRuleHead).toBeUndefined()
    expect(own.reserveBalanceWei).toBeUndefined()
    expect(() => createEvmChain(own)).not.toThrow()
  })

  it('a local development node standing in for the network says so explicitly', () => {
    expect(() => createEvmChain({ ...base, localNodeWithoutSpendRule: true })).not.toThrow()
    expect(() =>
      createEvmChain({
        ...base,
        localNodeWithoutSpendRule: true,
        spendSpacingBlocks: 3,
        reserveBalanceWei: 10n ** 18n,
      }),
    ).not.toThrow()
  })
})
