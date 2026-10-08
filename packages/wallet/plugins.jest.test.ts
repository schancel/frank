/**
 * Unit Tests for DAppPlugin Host & Triple Reference Plugins (Ticket #1154).
 */

import { Wallet } from 'ethers'
import * as bip39 from 'bip39'
import {
  DAppPluginRegistry,
  defaultPluginRegistry,
  createStandardPluginRegistry,
  UniswapDAppPlugin,
  JupiterDAppPlugin,
  PredictionEscrowDAppPlugin,
  findAssociatedTokenAddress,
  DEFAULT_UNISWAP_FEE_RECIPIENT,
  DEFAULT_UNISWAP_ROUTER_ADDRESS,
  JUPITER_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  DEFAULT_JUPITER_FEE_ACCOUNT,
  DEFAULT_PREDICTION_ESCROW_DOMAIN,
  type PredictionOrder,
  type DAppQuoteRequest,
} from './plugins'
import { EvmChangeKeyring } from './secp256k1-hd-keyring'
import { SolanaChangeKeyring, SolanaHdKeyring } from './ed25519-hd-keyring'

describe('DAppPlugin Host & Triple Reference Plugins (Ticket #1154)', () => {
  const TEST_MNEMONIC =
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

  describe('DAppPluginRegistry Host', () => {
    let registry: DAppPluginRegistry

    beforeEach(() => {
      registry = new DAppPluginRegistry()
    })

    it('registers, looks up, and lists plugins', () => {
      const uniswap = new UniswapDAppPlugin()
      const jupiter = new JupiterDAppPlugin()
      const prediction = new PredictionEscrowDAppPlugin()

      registry.register(uniswap)
      registry.register(jupiter)
      registry.register(prediction)

      expect(registry.has(uniswap.id)).toBe(true)
      expect(registry.has(jupiter.id)).toBe(true)
      expect(registry.has(prediction.id)).toBe(true)
      expect(registry.get(uniswap.id)).toBe(uniswap)
      expect(registry.require(jupiter.id)).toBe(jupiter)
      expect(registry.list()).toHaveLength(3)
    })

    it('rejects duplicate plugin registration with clear error', () => {
      const uniswap1 = new UniswapDAppPlugin()
      const uniswap2 = new UniswapDAppPlugin()

      registry.register(uniswap1)
      expect(() => registry.register(uniswap2)).toThrow(/already registered/)
    })

    it('unregisters plugins cleanly', () => {
      const uniswap = new UniswapDAppPlugin()
      registry.register(uniswap)
      expect(registry.has(uniswap.id)).toBe(true)

      const removed = registry.unregister(uniswap.id)
      expect(removed).toBe(true)
      expect(registry.has(uniswap.id)).toBe(false)
      expect(registry.get(uniswap.id)).toBeUndefined()
      expect(() => registry.require(uniswap.id)).toThrow(/not found/)
    })

    it('filters plugins by chain type', () => {
      const uniswap = new UniswapDAppPlugin() // evm
      const jupiter = new JupiterDAppPlugin() // solana
      const prediction = new PredictionEscrowDAppPlugin() // evm

      registry.register(uniswap)
      registry.register(jupiter)
      registry.register(prediction)

      const evmPlugins = registry.getByChainType('evm')
      expect(evmPlugins.map(p => p.id)).toEqual([uniswap.id, prediction.id])

      const solanaPlugins = registry.getByChainType('solana')
      expect(solanaPlugins.map(p => p.id)).toEqual([jupiter.id])
    })

    it('provides valid metadata for each plugin', () => {
      const uniswap = new UniswapDAppPlugin()
      const jupiter = new JupiterDAppPlugin()
      const prediction = new PredictionEscrowDAppPlugin()

      expect(uniswap.getMetadata().chainType).toBe('evm')
      expect(uniswap.getMetadata().id).toBe('uniswap-universal-router')

      expect(jupiter.getMetadata().chainType).toBe('solana')
      expect(jupiter.getMetadata().id).toBe('jupiter-aggregator')

      expect(prediction.getMetadata().chainType).toBe('evm')
      expect(prediction.getMetadata().id).toBe('prediction-escrow')
    })

    it('instantiates standard plugin registry with all reference plugins pre-registered', () => {
      const registry = createStandardPluginRegistry()
      expect(registry.list().length).toBe(3)
      expect(registry.has('uniswap-universal-router')).toBe(true)
      expect(registry.has('jupiter-aggregator')).toBe(true)
      expect(registry.has('prediction-escrow')).toBe(true)
    })
  })

  describe('Uniswap Universal Router Reference Plugin', () => {
    const plugin = new UniswapDAppPlugin()
    let evmChangeKeyring: EvmChangeKeyring

    beforeAll(() => {
      evmChangeKeyring = EvmChangeKeyring.fromMnemonic(TEST_MNEMONIC)
    })

    it('calculates quote with 8.75 bps protocol convenience fee deduction for USDC -> MON', async () => {
      // 1,000,000 micro-USDC = 1.0 USDC
      const inputAmount = 1_000_000n
      const quote = await plugin.getQuote({
        inputToken: 'USDC',
        outputToken: 'MON',
        inputAmount,
      })

      // 8.75 bps = 875 / 1,000,000
      // Expected fee on 1,000,000 units is exactly 875 units
      expect(quote.feeAmount).toBe(875n)
      expect(quote.feeBps).toBe(8.75)
      expect(quote.feeRecipient).toBe(DEFAULT_UNISWAP_FEE_RECIPIENT)

      // Net input: 999,125 units ($0.999125)
      // At $3.50 / MON, 0.999125 / 3.5 = ~0.285464 MON (~2.85464e17 wei)
      expect(quote.expectedOutputAmount).toBeGreaterThan(0n)
      expect(quote.minOutputAmount).toBeLessThan(quote.expectedOutputAmount)
      // Default 50 bps slippage: min is 99.5% of expected
      expect(quote.minOutputAmount).toBe(
        (quote.expectedOutputAmount * 9950n) / 10000n,
      )
    })

    it('calculates quote for USDC -> AVU (energy anchor equivalent)', async () => {
      // 10,000,000 micro-USDC = 10.0 USDC
      const inputAmount = 10_000_000n
      const quote = await plugin.getQuote({
        inputToken: 'USDC',
        outputToken: 'AVU',
        inputAmount,
      })

      // Fee: (10,000,000 * 875) / 1,000,000 = 8,750 micro-USDC
      expect(quote.feeAmount).toBe(8_750n)
      // 1 AVU = $0.084. Net ~$9.99125 -> ~118.94 AVU (18 decimals)
      expect(quote.expectedOutputAmount).toBeGreaterThan(118n * 10n ** 18n)
      expect(quote.expectedOutputAmount).toBeLessThan(120n * 10n ** 18n)
    })

    it('builds transaction settling directly to derived HD change address m/44/60/0/1/0', async () => {
      // Derive fresh HD change address from EvmChangeKeyring (m/44'/60'/0'/1/0)
      const changeAccount = evmChangeKeyring.deriveChangeAccount(0)
      expect(changeAccount.index).toBe(0)
      const destinationChangeAddress = changeAccount.address

      const quote = await plugin.getQuote({
        inputToken: 'USDC',
        outputToken: 'MON',
        inputAmount: 5_000_000n,
      })

      const preparedTx = await plugin.buildTransaction({
        quote,
        userAddress: '0x1111111111111111111111111111111111111111',
        destinationAddress: destinationChangeAddress,
        deadline: 1800000000,
      })

      expect(preparedTx.chainType).toBe('evm')
      expect(preparedTx.to).toBe(DEFAULT_UNISWAP_ROUTER_ADDRESS)
      expect(preparedTx.recipient).toBe(destinationChangeAddress)
      expect(preparedTx.data).toBeDefined()

      // Decode and verify the calldata commands and recipient parameter
      const decoded = plugin.decodeExecuteCalldata(preparedTx.data!)
      expect(decoded.commands).toBe('0x0600') // 0x06 PAY_PORTION, 0x00 V3_SWAP_EXACT_IN
      expect(decoded.feeRecipient?.toLowerCase()).toBe(
        DEFAULT_UNISWAP_FEE_RECIPIENT.toLowerCase(),
      )
      expect(decoded.feeBps).toBe(8.75)
      expect(decoded.swapRecipient?.toLowerCase()).toBe(
        destinationChangeAddress.toLowerCase(),
      )
      expect(decoded.amountIn).toBe(5_000_000n - quote.feeAmount)
      expect(decoded.amountOutMin).toBe(quote.minOutputAmount)
      expect(decoded.payerIsUser).toBe(true)
    })

    it('refuses to build transaction when destination change address is missing', async () => {
      const quote = await plugin.getQuote({
        inputToken: 'USDC',
        outputToken: 'MON',
        inputAmount: 1_000_000n,
      })

      await expect(
        plugin.buildTransaction({
          quote,
          userAddress: '0x1111111111111111111111111111111111111111',
        }),
      ).rejects.toThrow(/destinationAddress/)
    })
  })

  describe('Jupiter Aggregator Reference Plugin (Solana)', () => {
    const plugin = new JupiterDAppPlugin()
    let solanaChangeKeyring: SolanaChangeKeyring

    beforeAll(async () => {
      solanaChangeKeyring = await SolanaChangeKeyring.fromMnemonic(
        TEST_MNEMONIC,
      )
    })

    it('calculates quote with platform fee sharing (8.75 bps) for SOL -> USDC', async () => {
      // 1 SOL = 1,000,000,000 lamports
      const inputAmount = 1_000_000_000n
      const quote = await plugin.getQuote({
        inputToken: 'SOL',
        outputToken: 'USDC',
        inputAmount,
      })

      // 8.75 bps fee on 1,000,000,000 lamports = 875,000 lamports
      expect(quote.feeAmount).toBe(875_000n)
      expect(quote.feeBps).toBe(8.75)
      expect(quote.feeRecipient).toBe(DEFAULT_JUPITER_FEE_ACCOUNT)

      // Expected output at $150 / SOL for net ~0.999125 SOL:
      // ~149.868750 USDC (6 decimals -> ~149,868,750 units)
      expect(quote.expectedOutputAmount).toBeGreaterThan(149_000_000n)
      expect(quote.expectedOutputAmount).toBeLessThan(151_000_000n)
      expect(quote.minOutputAmount).toBe(
        (quote.expectedOutputAmount * 9950n) / 10000n,
      )

      // Verify Jupiter raw quote payload structure
      const rawQuote = quote.rawQuote as any
      expect(rawQuote.platformFee.amount).toBe('875000')
      expect(rawQuote.platformFee.feeBps).toBe(8.75)
      expect(rawQuote.platformFee.feeAccount).toBe(DEFAULT_JUPITER_FEE_ACCOUNT)
    })

    it('builds transaction setting up destination ATA for fresh HD change address', async () => {
      // Derive fresh Solana change address (SLIP-0010 m/44'/501'/0'/1'/0')
      const changeAccount = await solanaChangeKeyring.deriveChangeAccount(0)
      const freshChangeAddress = changeAccount.address

      // Derive spend address (SLIP-0010 m/44'/501'/0'/0'/0')
      const solanaSpendKeyring = await SolanaHdKeyring.fromMnemonic(
        TEST_MNEMONIC,
      )
      const spendAccount = await solanaSpendKeyring.deriveSubAccount(0)
      const userAddress = spendAccount.address

      const quote = await plugin.getQuote({
        inputToken: 'SOL',
        outputToken: 'USDC',
        inputAmount: 2_000_000_000n,
      })

      const preparedTx = await plugin.buildTransaction({
        quote,
        userAddress,
        destinationAddress: freshChangeAddress,
      })

      expect(preparedTx.chainType).toBe('solana')
      expect(preparedTx.recipient).toBe(freshChangeAddress)
      expect(preparedTx.instructions).toBeDefined()
      expect(preparedTx.instructions!.length).toBeGreaterThanOrEqual(2)

      // 1. Destination ATA setup instruction
      const ataIx = preparedTx.instructions![0] as any
      expect(ataIx.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID)
      // Check that owner account of the ATA is the fresh change address
      expect(ataIx.keys[2].pubkey.toBase58()).toBe(freshChangeAddress)

      // 2. Jupiter Swap instruction
      const swapIx = preparedTx.instructions![1] as any
      expect(swapIx.programId.toBase58()).toBe(JUPITER_PROGRAM_ID)
      // Destination token account matches the derived destination ATA
      const [expectedDestinationAta] = await findAssociatedTokenAddress(
        freshChangeAddress,
        plugin.resolveToken('USDC').mint,
      )
      expect(swapIx.keys[1].pubkey.toBase58()).toBe(
        expectedDestinationAta.toBase58(),
      )

      // 3. Platform fee transfer instruction
      if (preparedTx.instructions!.length >= 3) {
        const feeIx = preparedTx.instructions![2] as any
        expect(feeIx.programId.toBase58()).toBe(TOKEN_PROGRAM_ID)
        expect(feeIx.keys[1].pubkey.toBase58()).toBe(
          DEFAULT_JUPITER_FEE_ACCOUNT,
        )
      }
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

    it('sets native value when swapping native input token (MON -> USDC)', async () => {
      const plugin = new UniswapDAppPlugin()
      const quote = await plugin.getQuote({
        inputToken: 'MON',
        outputToken: 'USDC',
        inputAmount: 2_000_000_000_000_000_000n, // 2 MON
      })

      const preparedTx = await plugin.buildTransaction({
        quote,
        userAddress: '0x1111111111111111111111111111111111111111',
        destinationAddress: '0x2222222222222222222222222222222222222222',
      })

      expect(preparedTx.value).toBe(quote.inputAmount)
    })

    it('rejects invalid paths or zero amounts in Uniswap and Jupiter', async () => {
      const uniswap = new UniswapDAppPlugin()
      const jupiter = new JupiterDAppPlugin()

      await expect(
        uniswap.getQuote({
          inputToken: 'USDC',
          outputToken: 'MON',
          inputAmount: 0n,
        }),
      ).rejects.toThrow(RangeError)

      expect(() =>
        uniswap.encodeV3Path(['0x1111111111111111111111111111111111111111']),
      ).toThrow(/Path must contain at least 2 tokens/)

      await expect(
        jupiter.getQuote({
          inputToken: 'SOL',
          outputToken: 'USDC',
          inputAmount: -5n,
        }),
      ).rejects.toThrow(RangeError)

      await expect(
        jupiter.buildTransaction({
          quote: await jupiter.getQuote({
            inputToken: 'SOL',
            outputToken: 'USDC',
            inputAmount: 100_000_000n,
          }),
          userAddress: 'So11111111111111111111111111111111111111112',
        }),
      ).rejects.toThrow(/destinationAddress/)
    })
  })
})
