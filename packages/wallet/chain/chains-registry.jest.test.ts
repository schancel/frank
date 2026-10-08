import { readFileSync } from 'fs'
import { join } from 'path'
import {
  PROTOCOL_CHAINS,
  CANONICAL_EVM_CONTRACTS,
  CANONICAL_SOLANA_CONTRACTS,
  getChainRegistryEntry,
  getChainRegistryByKind,
  getChainRegistryByNetworkTag,
  getChainRegistryByCaip2,
  getChainsByCurve,
  resolveChainIdentifier,
  getAllChainsByKind,
  getChainsByFamily,
  registerProtocolChain,
  clearDynamicChains,
  getChainExchangeConfig,
} from './chains-registry'

describe('chains-registry', () => {
  it('defines all canonical mainnet and testnet chain configurations', () => {
    expect(PROTOCOL_CHAINS['monad-testnet']).toEqual({
      id: 'monad-testnet',
      kind: 'monad',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Monad Testnet',
      unit: 'MONT',
      caip2: 'eip155:10143',
      nativeChainId: 10143,
      networkTag: 'MONT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: { from: 'MON', to: 'USDC', defaultAmount: '100' },
        supportedAssets: ['MON', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['monad-mainnet']).toEqual({
      id: 'monad-mainnet',
      kind: 'monad',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Monad',
      unit: 'MON',
      caip2: 'eip155:143',
      nativeChainId: 143,
      networkTag: 'MON1',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: { from: 'MON', to: 'USDC', defaultAmount: '100' },
        supportedAssets: ['MON', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['xec-testnet']).toEqual({
      id: 'xec-testnet',
      kind: 'ecash',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'eCash Testnet',
      unit: 'tXEC',
      addressPrefix: 'ectest',
      networkTag: 'XECT',
      exchange: {
        pluginId: 'ecash-atomic-swap',
        routerName: 'eCash Atomic Swap Router',
        adapterType: 'atomic-swap',
        defaultPair: { from: 'XEC', to: 'USDC', defaultAmount: '1000000' },
        supportedAssets: ['XEC', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['xec-mainnet']).toEqual({
      id: 'xec-mainnet',
      kind: 'ecash',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'eCash',
      unit: 'XEC',
      addressPrefix: 'ecash',
      networkTag: 'XEC1',
      exchange: {
        pluginId: 'ecash-atomic-swap',
        routerName: 'eCash Atomic Swap Router',
        adapterType: 'atomic-swap',
        defaultPair: { from: 'XEC', to: 'USDC', defaultAmount: '1000000' },
        supportedAssets: ['XEC', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['solana-devnet']).toEqual({
      id: 'solana-devnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'testnet',
      isTestnet: true,
      name: 'Solana Devnet',
      unit: 'dSOL',
      caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      networkTag: 'SOLD',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: {
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: { from: 'SOL', to: 'USDC', defaultAmount: '1' },
        supportedAssets: ['SOL', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['solana-testnet']).toEqual({
      id: 'solana-testnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'testnet',
      isTestnet: true,
      name: 'Solana Testnet',
      unit: 'tSOL',
      caip2: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
      networkTag: 'SOLT',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: {
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: { from: 'SOL', to: 'USDC', defaultAmount: '1' },
        supportedAssets: ['SOL', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['solana-mainnet']).toEqual({
      id: 'solana-mainnet',
      kind: 'solana',
      family: 'solana',
      curve: 'ed25519',
      keyType: 2,
      network: 'mainnet',
      isTestnet: false,
      name: 'Solana',
      unit: 'SOL',
      caip2: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      networkTag: 'SOL1',
      contracts: CANONICAL_SOLANA_CONTRACTS,
      exchange: {
        pluginId: 'jupiter-aggregator',
        routerName: 'Jupiter Aggregator v6',
        adapterType: 'dex-aggregator',
        defaultPair: { from: 'SOL', to: 'USDC', defaultAmount: '1' },
        supportedAssets: ['SOL', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['ethereum-sepolia']).toEqual({
      id: 'ethereum-sepolia',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Sepolia',
      unit: 'SEP',
      caip2: 'eip155:11155111',
      nativeChainId: 11155111,
      networkTag: 'SEPO',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: { from: 'ETH', to: 'USDC', defaultAmount: '0.1' },
        supportedAssets: ['ETH', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['ethereum-holesky']).toEqual({
      id: 'ethereum-holesky',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Holesky',
      unit: 'HOL',
      caip2: 'eip155:17000',
      nativeChainId: 17000,
      networkTag: 'HOLE',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: { from: 'ETH', to: 'USDC', defaultAmount: '0.1' },
        supportedAssets: ['ETH', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['ethereum-mainnet']).toEqual({
      id: 'ethereum-mainnet',
      kind: 'ethereum',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Ethereum',
      unit: 'ETH',
      caip2: 'eip155:1',
      nativeChainId: 1,
      networkTag: 'ETH1',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'uniswap-universal-router',
        routerName: 'Uniswap Universal Router',
        adapterType: 'dex-router',
        defaultPair: { from: 'ETH', to: 'USDC', defaultAmount: '0.1' },
        supportedAssets: ['ETH', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['hyperliquid-mainnet']).toEqual({
      id: 'hyperliquid-mainnet',
      kind: 'hyperliquid',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Hyperliquid',
      unit: 'HYPE',
      caip2: 'eip155:999',
      nativeChainId: 999,
      networkTag: 'HYPE',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'hyperliquid-l1',
        routerName: 'Hyperliquid L1 Orderbook Router',
        adapterType: 'clob-orderbook',
        defaultPair: { from: 'HYPE', to: 'USDC', defaultAmount: '10' },
        supportedAssets: ['HYPE', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['hyperliquid-testnet']).toEqual({
      id: 'hyperliquid-testnet',
      kind: 'hyperliquid',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Hyperliquid Testnet',
      unit: 'tHYPE',
      caip2: 'eip155:998',
      nativeChainId: 998,
      networkTag: 'HYPT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'hyperliquid-l1',
        routerName: 'Hyperliquid L1 Orderbook Router',
        adapterType: 'clob-orderbook',
        defaultPair: { from: 'HYPE', to: 'USDC', defaultAmount: '10' },
        supportedAssets: ['HYPE', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['tempo-mainnet']).toEqual({
      id: 'tempo-mainnet',
      kind: 'tempo',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Tempo',
      unit: 'USD',
      caip2: 'eip155:4217',
      nativeChainId: 4217,
      networkTag: 'TMPO',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'tempo-router',
        routerName: 'Tempo Settlement Engine',
        adapterType: 'settlement-engine',
        defaultPair: { from: 'USD', to: 'USDC', defaultAmount: '100' },
        supportedAssets: ['USD', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['tempo-testnet']).toEqual({
      id: 'tempo-testnet',
      kind: 'tempo',
      family: 'evm',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Tempo Moderato',
      unit: 'tUSD',
      caip2: 'eip155:42431',
      nativeChainId: 42431,
      networkTag: 'TMPT',
      contracts: CANONICAL_EVM_CONTRACTS,
      exchange: {
        pluginId: 'tempo-router',
        routerName: 'Tempo Settlement Engine',
        adapterType: 'settlement-engine',
        defaultPair: { from: 'USD', to: 'USDC', defaultAmount: '100' },
        supportedAssets: ['USD', 'USDC', 'USDT', 'AVU'],
      },
    })

    expect(PROTOCOL_CHAINS['btc-mainnet']).toEqual({
      id: 'btc-mainnet',
      kind: 'bitcoin',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Bitcoin',
      unit: 'BTC',
      caip2: 'bip122:000000000019d6689c085ae165831e93',
      networkTag: 'BTC1',
      electrumServers: ['wss://electrum.blockstream.info:50002'],
    })

    expect(PROTOCOL_CHAINS['btc-testnet']).toEqual({
      id: 'btc-testnet',
      kind: 'bitcoin',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'testnet',
      isTestnet: true,
      name: 'Bitcoin Testnet',
      unit: 'tBTC',
      caip2: 'bip122:000000000933ea01ad0ee984209779ba',
      networkTag: 'BTCT',
      electrumServers: ['wss://electrum.blockstream.info:60002'],
    })

    expect(PROTOCOL_CHAINS['bch-mainnet']).toEqual({
      id: 'bch-mainnet',
      kind: 'bitcoincash',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Bitcoin Cash',
      unit: 'BCH',
      addressPrefix: 'bitcoincash',
      networkTag: 'BCH1',
      electrumServers: [
        'wss://fulcrum.fountainhead.cash:50004',
        'wss://bch.ninja:50004',
      ],
    })

    expect(PROTOCOL_CHAINS['doge-mainnet']).toEqual({
      id: 'doge-mainnet',
      kind: 'dogecoin',
      family: 'bitcoin',
      curve: 'secp256k1',
      keyType: 1,
      network: 'mainnet',
      isTestnet: false,
      name: 'Dogecoin',
      unit: 'DOGE',
      networkTag: 'DOGE',
      electrumServers: [
        'wss://electrum.doge.keys4coins.com:50002',
        'wss://doge-electrum.cryptonode.id:50004',
      ],
    })
  })

  it('resolves exchange router configuration via getChainExchangeConfig', () => {
    expect(getChainExchangeConfig('monad')?.routerName).toBe(
      'Uniswap Universal Router',
    )
    expect(getChainExchangeConfig('ecash')?.routerName).toBe(
      'eCash Atomic Swap Router',
    )
    expect(getChainExchangeConfig('ecash')?.pluginId).toBe('ecash-atomic-swap')
    expect(getChainExchangeConfig('xec-mainnet')?.adapterType).toBe(
      'atomic-swap',
    )
    expect(getChainExchangeConfig('solana')?.routerName).toBe(
      'Jupiter Aggregator v6',
    )
    expect(getChainExchangeConfig('solana')?.pluginId).toBe(
      'jupiter-aggregator',
    )
    expect(getChainExchangeConfig('ethereum')?.routerName).toBe(
      'Uniswap Universal Router',
    )
    expect(getChainExchangeConfig('hyperliquid')?.routerName).toBe(
      'Hyperliquid L1 Orderbook Router',
    )
    expect(getChainExchangeConfig('tempo')?.routerName).toBe(
      'Tempo Settlement Engine',
    )
  })

  it('resolves entries by id and by kind + isTestnet', () => {
    expect(getChainRegistryEntry('monad-testnet')?.unit).toBe('MONT')
    expect(getChainRegistryEntry('monad-mainnet')?.unit).toBe('MON')
    expect(getChainRegistryEntry('non-existent')).toBeUndefined()

    expect(getChainRegistryByKind('monad', true).unit).toBe('MONT')
    expect(getChainRegistryByKind('monad', false).unit).toBe('MON')
    expect(getChainRegistryByKind('ecash', true).unit).toBe('tXEC')
    expect(getChainRegistryByKind('ecash', false).unit).toBe('XEC')
    expect(getChainRegistryByKind('solana', true).unit).toBe('dSOL')
    expect(getChainRegistryByKind('solana', false).unit).toBe('SOL')
    expect(getChainRegistryByKind('ethereum', true).unit).toBe('SEP')
    expect(getChainRegistryByKind('ethereum', false).unit).toBe('ETH')
    expect(getChainRegistryByKind('hyperliquid', true).unit).toBe('tHYPE')
    expect(getChainRegistryByKind('hyperliquid', false).unit).toBe('HYPE')
    expect(getChainRegistryByKind('tempo', true).unit).toBe('tUSD')
    expect(getChainRegistryByKind('tempo', false).unit).toBe('USD')
  })

  it('resolves entries by networkTag', () => {
    expect(getChainRegistryByNetworkTag('MONT')?.id).toBe('monad-testnet')
    expect(getChainRegistryByNetworkTag('MON1')?.id).toBe('monad-mainnet')
    expect(getChainRegistryByNetworkTag('SOLD')?.id).toBe('solana-devnet')
    expect(getChainRegistryByNetworkTag('SOL1')?.id).toBe('solana-mainnet')
    expect(getChainRegistryByNetworkTag('SEPO')?.id).toBe('ethereum-sepolia')
    expect(getChainRegistryByNetworkTag('HYPE')?.id).toBe('hyperliquid-mainnet')
    expect(getChainRegistryByNetworkTag('HYPT')?.id).toBe('hyperliquid-testnet')
    expect(getChainRegistryByNetworkTag('TMPO')?.id).toBe('tempo-mainnet')
    expect(getChainRegistryByNetworkTag('TMPT')?.id).toBe('tempo-testnet')
    expect(getChainRegistryByNetworkTag('UNKNOWN')).toBeUndefined()
  })

  it('resolves entries by CAIP-2', () => {
    expect(getChainRegistryByCaip2('eip155:10143')?.id).toBe('monad-testnet')
    expect(getChainRegistryByCaip2('eip155:1')?.id).toBe('ethereum-mainnet')
    expect(getChainRegistryByCaip2('eip155:999')?.id).toBe(
      'hyperliquid-mainnet',
    )
    expect(getChainRegistryByCaip2('eip155:4217')?.id).toBe('tempo-mainnet')
    expect(
      getChainRegistryByCaip2('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')?.id,
    ).toBe('solana-mainnet')
    expect(getChainRegistryByCaip2('invalid:caip2')).toBeUndefined()
  })

  it('groups chains by curve family', () => {
    const secp256k1Chains = getChainsByCurve('secp256k1')
    expect(
      secp256k1Chains.every(c => c.curve === 'secp256k1' && c.keyType === 1),
    ).toBe(true)
    expect(secp256k1Chains.map(c => c.id)).toContain('monad-testnet')
    expect(secp256k1Chains.map(c => c.id)).toContain('ethereum-mainnet')

    const ed25519Chains = getChainsByCurve('ed25519')
    expect(
      ed25519Chains.every(c => c.curve === 'ed25519' && c.keyType === 2),
    ).toBe(true)
    expect(ed25519Chains.map(c => c.id)).toContain('solana-mainnet')
    expect(ed25519Chains.map(c => c.id)).toContain('solana-devnet')
  })

  it('resolves chain identifier from id, networkTag, or CAIP-2', () => {
    expect(resolveChainIdentifier('monad-testnet')?.id).toBe('monad-testnet')
    expect(resolveChainIdentifier('MONT')?.id).toBe('monad-testnet')
    expect(resolveChainIdentifier('eip155:10143')?.id).toBe('monad-testnet')
    expect(resolveChainIdentifier('solana-devnet')?.id).toBe('solana-devnet')
    expect(resolveChainIdentifier('SOLD')?.id).toBe('solana-devnet')
    expect(resolveChainIdentifier('ethereum-sepolia')?.id).toBe(
      'ethereum-sepolia',
    )
    expect(resolveChainIdentifier('SEPO')?.id).toBe('ethereum-sepolia')
    expect(resolveChainIdentifier('eip155:11155111')?.id).toBe(
      'ethereum-sepolia',
    )
    expect(resolveChainIdentifier('nonexistent')).toBeUndefined()
  })

  it('exposes canonical smart contract addresses for EVM chains and undefined for non-EVM', () => {
    expect(CANONICAL_EVM_CONTRACTS.stateChannel).toBe(
      '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57',
    )
    expect(CANONICAL_EVM_CONTRACTS.htlc).toBe(
      '0x391a080Bd6FF21CB4598adF063Dc94018CD186E5',
    )
    expect(CANONICAL_EVM_CONTRACTS.channelVault).toBe(
      '0x18E98e3B789F0b84c7060Bb28bF4385809F3aF57',
    )
    expect(CANONICAL_EVM_CONTRACTS.tablePotVault).toBe(
      '0x391a080Bd6FF21CB4598adF063Dc94018CD186E5',
    )

    expect(PROTOCOL_CHAINS['monad-testnet'].contracts).toBe(
      CANONICAL_EVM_CONTRACTS,
    )
    expect(PROTOCOL_CHAINS['monad-mainnet'].contracts).toBe(
      CANONICAL_EVM_CONTRACTS,
    )
    expect(PROTOCOL_CHAINS['solana-mainnet'].contracts).toBe(
      CANONICAL_SOLANA_CONTRACTS,
    )
    expect(PROTOCOL_CHAINS['xec-mainnet'].contracts).toBeUndefined()
  })

  describe('multi-testnet and family queries', () => {
    it('returns all testnets for a chain kind supporting multiple concurrent testnets', () => {
      const ethTestnets = getAllChainsByKind('ethereum', { isTestnet: true })
      expect(ethTestnets.map(c => c.id)).toEqual([
        'ethereum-sepolia',
        'ethereum-holesky',
      ])

      const ethMainnets = getAllChainsByKind('ethereum', { isTestnet: false })
      expect(ethMainnets.map(c => c.id)).toEqual(['ethereum-mainnet'])

      const allEth = getAllChainsByKind('ethereum')
      expect(allEth.map(c => c.id)).toEqual([
        'ethereum-sepolia',
        'ethereum-holesky',
        'ethereum-mainnet',
      ])

      const solTestnets = getAllChainsByKind('solana', { isTestnet: true })
      expect(solTestnets.map(c => c.id)).toEqual([
        'solana-devnet',
        'solana-testnet',
      ])
    })

    it('returns chains filtered by cryptographic/VM family', () => {
      const evmTestnets = getChainsByFamily('evm', { isTestnet: true })
      const evmTestnetIds = evmTestnets.map(c => c.id)
      expect(evmTestnetIds).toContain('monad-testnet')
      expect(evmTestnetIds).toContain('ethereum-sepolia')
      expect(evmTestnetIds).toContain('ethereum-holesky')
      expect(evmTestnetIds).toContain('hyperliquid-testnet')
      expect(evmTestnetIds).toContain('tempo-testnet')
      expect(evmTestnets.every(c => c.family === 'evm' && c.isTestnet)).toBe(
        true,
      )

      const solanaChains = getChainsByFamily('solana')
      expect(solanaChains.map(c => c.id)).toEqual([
        'solana-devnet',
        'solana-testnet',
        'solana-mainnet',
      ])
    })
  })

  describe('dynamic chain registration (arbitrary & rotating testnets)', () => {
    afterEach(() => {
      clearDynamicChains()
    })

    it('registers an arbitrary rotating testnet without codebase modifications', () => {
      const ephemeralTestnet = {
        id: 'ethereum-ephemeral-1',
        kind: 'ethereum' as const,
        family: 'evm' as const,
        curve: 'secp256k1' as const,
        keyType: 1 as const,
        network: 'testnet' as const,
        isTestnet: true,
        name: 'Ethereum Ephemeral Devnet 1',
        unit: 'EPH',
        caip2: 'eip155:999999',
        nativeChainId: 999999,
        networkTag: 'EPHT',
      }

      expect(getChainRegistryEntry('ethereum-ephemeral-1')).toBeUndefined()
      registerProtocolChain(ephemeralTestnet)

      // Resolvable via direct ID lookup
      const entry = getChainRegistryEntry('ethereum-ephemeral-1')
      expect(entry).toBeDefined()
      expect(entry?.unit).toBe('EPH')

      // Resolvable via networkTag, CAIP-2, and resolveChainIdentifier
      expect(getChainRegistryByNetworkTag('EPHT')?.id).toBe(
        'ethereum-ephemeral-1',
      )
      expect(getChainRegistryByCaip2('eip155:999999')?.id).toBe(
        'ethereum-ephemeral-1',
      )
      expect(resolveChainIdentifier('EPHT')?.id).toBe('ethereum-ephemeral-1')
      expect(resolveChainIdentifier('eip155:999999')?.id).toBe(
        'ethereum-ephemeral-1',
      )

      // Included in multi-testnet queries
      const ethTestnets = getAllChainsByKind('ethereum', { isTestnet: true })
      expect(ethTestnets.map(c => c.id)).toContain('ethereum-ephemeral-1')
      expect(ethTestnets.length).toBe(3) // sepolia, holesky, ephemeral-1

      // Included in family queries
      const evmTestnets = getChainsByFamily('evm', { isTestnet: true })
      expect(evmTestnets.map(c => c.id)).toContain('ethereum-ephemeral-1')

      // clearDynamicChains resets state cleanly
      clearDynamicChains()
      expect(getChainRegistryEntry('ethereum-ephemeral-1')).toBeUndefined()
      expect(getAllChainsByKind('ethereum', { isTestnet: true }).length).toBe(2)
    })
  })

  describe('relay protocol synchronization (docs/protocol/chains/v1.json)', () => {
    const protocolRegistry = JSON.parse(
      readFileSync(
        join(__dirname, '../../../docs/protocol/chains/v1.json'),
        'utf8',
      ),
    ) as {
      schema_version: number
      chains: Array<{
        id: string
        family: string
        network: string
        caip2: string
        native_chain_id?: string
        allowed_proxy_capabilities: string[]
      }>
    }

    it('verifies protocol registry schema version and chain count', () => {
      expect(protocolRegistry.schema_version).toBe(1)
      expect(protocolRegistry.chains.length).toBe(21)
    })

    it('ensures wallet and relay protocol registries agree on shared chain identifiers and properties', () => {
      const protocolChainsMap = new Map(
        protocolRegistry.chains.map(c => [c.id, c]),
      )

      for (const [id, entry] of Object.entries(PROTOCOL_CHAINS)) {
        if (!protocolChainsMap.has(id)) {
          continue
        }

        const protocolChain = protocolChainsMap.get(id)!
        expect(entry.id).toBe(protocolChain.id)
        expect(entry.family).toBe(protocolChain.family)
        if (protocolChain.caip2 != null) {
          expect(entry.caip2).toBe(protocolChain.caip2)
        } else {
          expect(entry.caip2).toBeUndefined()
        }
        expect(entry.network).toBe(protocolChain.network)
        if (protocolChain.native_chain_id != null) {
          expect(String(entry.nativeChainId)).toBe(
            protocolChain.native_chain_id,
          )
        } else {
          expect(entry.nativeChainId).toBeUndefined()
        }
      }
    })

    it('ensures every canonical protocol EVM and Solana chain is registered in wallet PROTOCOL_CHAINS', () => {
      const activeFamilies = new Set(['evm', 'solana'])
      for (const chain of protocolRegistry.chains) {
        if (activeFamilies.has(chain.family)) {
          expect(PROTOCOL_CHAINS[chain.id]).toBeDefined()
          expect(PROTOCOL_CHAINS[chain.id].family).toBe(chain.family)
        }
      }
    })
  })
})
