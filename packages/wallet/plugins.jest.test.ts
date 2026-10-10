/**
 * Unit Tests for DAppPlugin Host & Triple Reference Plugins (Ticket #1154).
 */

import { Wallet } from 'ethers'
import * as bip39 from 'bip39'
import {
  DAppPluginRegistry,
  defaultPluginRegistry,
  createStandardPluginRegistry,
  PredictionEscrowDAppPlugin,
  DEFAULT_PREDICTION_ESCROW_DOMAIN,
  type PredictionOrder,
  type DAppPlugin,
  type DAppQuoteRequest,
} from './plugins'
import { EvmChangeKeyring } from './secp256k1-hd-keyring'

describe('DAppPlugin Host & Triple Reference Plugins (Ticket #1154)', () => {
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  describe('DAppPluginRegistry Host', () => {
    let registry: DAppPluginRegistry
    // The registry host is tested with a stand-in: it is not a swap and quotes nothing.
    const solanaStub = (): DAppPlugin => ({
      ...evmStub(),
      id: 'solana-stub',
      chainType: 'solana',
    })
    const evmStub = (): DAppPlugin => ({
      id: 'evm-stub',
      name: 'EVM stub',
      chainType: 'evm',
      getMetadata: () => ({
        id: 'evm-stub',
        name: 'EVM stub',
        version: '0',
        description: 'registry test stand-in',
        chainType: 'evm',
      }),
      getQuote: () => Promise.reject(new Error('stub')),
      buildTransaction: () => Promise.reject(new Error('stub')),
    })

    beforeEach(() => {
      registry = new DAppPluginRegistry()
    })

    it('registers, looks up, and lists plugins', () => {
      const evm = evmStub()
      const solana = solanaStub()
      const prediction = new PredictionEscrowDAppPlugin()

      registry.register(evm)
      registry.register(solana)
      registry.register(prediction)

      expect(registry.has(evm.id)).toBe(true)
      expect(registry.has(solana.id)).toBe(true)
      expect(registry.has(prediction.id)).toBe(true)
      expect(registry.get(evm.id)).toBe(evm)
      expect(registry.require(solana.id)).toBe(solana)
      expect(registry.list()).toHaveLength(3)
    })

    it('rejects duplicate plugin registration with clear error', () => {
      const first = evmStub()
      const second = evmStub()

      registry.register(first)
      expect(() => registry.register(second)).toThrow(/already registered/)
    })

    it('unregisters plugins cleanly', () => {
      const evm = evmStub()
      registry.register(evm)
      expect(registry.has(evm.id)).toBe(true)

      const removed = registry.unregister(evm.id)
      expect(removed).toBe(true)
      expect(registry.has(evm.id)).toBe(false)
      expect(registry.get(evm.id)).toBeUndefined()
      expect(() => registry.require(evm.id)).toThrow(/not found/)
    })

    it('filters plugins by chain type', () => {
      const evm = evmStub() // evm
      const solana = solanaStub() // solana
      const prediction = new PredictionEscrowDAppPlugin() // evm

      registry.register(evm)
      registry.register(solana)
      registry.register(prediction)

      const evmPlugins = registry.getByChainType('evm')
      expect(evmPlugins.map(p => p.id)).toEqual([evm.id, prediction.id])

      const solanaPlugins = registry.getByChainType('solana')
      expect(solanaPlugins.map(p => p.id)).toEqual([solana.id])
    })

    it('provides valid metadata for each plugin', () => {
      const prediction = new PredictionEscrowDAppPlugin()

      expect(prediction.getMetadata().chainType).toBe('evm')
      expect(prediction.getMetadata().id).toBe('prediction-escrow')
    })

    it('registers no plugin whose answers were computed from constants', () => {
      for (const registry of [
        createStandardPluginRegistry(),
        defaultPluginRegistry,
      ])
        for (const removed of [
          'uniswap-universal-router',
          'ecash-atomic-swap',
          'tempo-router',
          'hyperliquid-l1',
          'prediction-escrow',
          'jupiter-aggregator',
        ])
          expect(registry.has(removed)).toBe(false)
    })
  })

  describe('Prediction Escrow Reference Plugin (EIP-712)', () => {
    const plugin = new PredictionEscrowDAppPlugin()
    let wallet: Wallet

    beforeAll(() => {
      wallet = Wallet.createRandom()
    })

    it('builds typed data payload matching eth_signTypedData_v4 schema', () => {
      const order: PredictionOrder = {
        marketId:
          '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        outcomeIndex: 1, // outcome: YES
        amount: 100n * 10n ** 18n,
        price: 650_000n, // $0.65 (65% implied probability)
        expiration: 1800000000,
        salt: 987654321n,
        maker: wallet.address,
      }

      const typedData = plugin.buildOrderTypedData(order)
      expect(typedData.primaryType).toBe('PredictionOrder')
      expect(typedData.domain.name).toBe(DEFAULT_PREDICTION_ESCROW_DOMAIN.name)
      expect(typedData.types.PredictionOrder).toHaveLength(6)

      const fieldNames = typedData.types.PredictionOrder.map(f => f.name)
      expect(fieldNames).toEqual([
        'marketId',
        'outcomeIndex',
        'amount',
        'price',
        'expiration',
        'salt',
      ])
    })

    it('hashes order and verifies EIP-712 signature against wallet keypair', async () => {
      const order: PredictionOrder = {
        marketId: 'us-election-2024-winner',
        outcomeIndex: 0, // outcome: NO
        amount: 500n * 10n ** 18n,
        price: 350_000n, // $0.35
        expiration: 1750000000,
        salt: 1122334455n,
      }

      const hash = plugin.hashOrder(order)
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/)

      // Sign typed data with wallet keypair
      const signature = await plugin.signOrder(wallet, order)

      // Signature verification
      const isValid = plugin.verifyOrderSignature(
        order,
        signature,
        wallet.address,
      )
      expect(isValid).toBe(true)

      // Wrong signer fails
      const wrongSigner = Wallet.createRandom().address
      const isWrongValid = plugin.verifyOrderSignature(
        order,
        signature,
        wrongSigner,
      )
      expect(isWrongValid).toBe(false)

      // Tampered order fails
      const tamperedOrder: PredictionOrder = {
        ...order,
        amount: order.amount * 2n,
      }
      const isTamperedValid = plugin.verifyOrderSignature(
        tamperedOrder,
        signature,
        wallet.address,
      )
      expect(isTamperedValid).toBe(false)
    })

    it('validates full EIP712TypedData payload with validateSignature()', async () => {
      const order: PredictionOrder = {
        marketId: 'super-bowl-winner',
        outcomeIndex: 1,
        amount: 250n * 10n ** 18n,
        price: 500_000n,
        expiration: 1760000000,
        salt: 445566n,
      }

      const typedData = plugin.buildOrderTypedData(order)
      const signature = await plugin.signOrder(wallet, order)

      const isPayloadValid = plugin.validateSignature(
        typedData,
        signature,
        wallet.address,
      )
      expect(isPayloadValid).toBe(true)
    })

    it('calculates quote and builds prepared transaction with typedData', async () => {
      const quote = await plugin.getQuote({
        inputToken: 'USDC',
        outputToken: 'PRED',
        inputAmount: 100_000_000n, // 100 USDC
        extra: {
          price: 600_000, // 0.60
          priceDenominator: 1_000_000,
        },
      })

      // Collateral = 100 * 0.60 = 60 USDC = 60_000_000
      expect(quote.expectedOutputAmount).toBe(60_000_000n)
      // Fee: 8.75 bps on 60_000_000 = (60_000_000 * 875) / 1,000,000 = 52,500
      expect(quote.feeAmount).toBe(52_500n)

      const preparedTx = await plugin.buildTransaction({
        quote,
        userAddress: wallet.address,
        extra: {
          marketId: 'crypto-total-mcap-3t',
          outcomeIndex: 1,
          price: 600_000n,
          salt: 999999n,
        },
      })

      expect(preparedTx.chainType).toBe('evm')
      expect(preparedTx.typedData).toBeDefined()
      expect(preparedTx.typedData?.primaryType).toBe('PredictionOrder')
      expect(preparedTx.recipient).toBe(wallet.address)
      expect(preparedTx.metadata?.orderHash).toBeDefined()
    })

    it('rejects invalid or zero quote input amount with RangeError', async () => {
      await expect(
        plugin.getQuote({
          inputToken: 'USDC',
          outputToken: 'PRED',
          inputAmount: 0n,
        }),
      ).rejects.toThrow(RangeError)
    })

    it('gracefully returns false on malformed signature verification', () => {
      const order: PredictionOrder = {
        marketId: 'test-market',
        outcomeIndex: 1,
        amount: 100n,
        price: 500_000n,
        expiration: 1800000000,
        salt: 1n,
      }
      expect(
        plugin.verifyOrderSignature(order, '0xinvalid', wallet.address),
      ).toBe(false)
    })
  })

  describe('Edge cases and multi-chain plugins', () => {
    it('supports multi-chain plugins in DAppPluginRegistry', () => {
      const registry = new DAppPluginRegistry()
      const multiPlugin = {
        id: 'cross-chain-swap',
        name: 'Cross Chain Swap',
        chainType: 'multi' as const,
        getMetadata: () => ({
          id: 'cross-chain-swap',
          name: 'Cross Chain Swap',
          version: '1.0.0',
          description: 'Multi-chain DEX bridge',
          chainType: 'multi' as const,
        }),
        getQuote: jest.fn(),
        buildTransaction: jest.fn(),
      }

      registry.register(multiPlugin)
      expect(registry.getByChainType('multi')).toEqual([multiPlugin])
      // Multi-chain plugins are surfaced when filtering by single chain types as well
      expect(registry.getByChainType('evm')).toContain(multiPlugin)
      expect(registry.getByChainType('solana')).toContain(multiPlugin)

      registry.clear()
      expect(registry.list()).toHaveLength(0)
    })
  })
})
