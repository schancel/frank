import { getBytes, hexlify, randomBytes, SigningKey, verifyMessage, Wallet } from 'ethers'
import { fromHex, toHex } from '@frank/codec'
import { MonadAccountTxSigner } from './monad-account-tx'
import {
  deriveEvmStealthAddress,
  deriveEvmStealthPrivateKey,
  MonadStealthKeyring,
  buildEvmStealthPayment,
} from './monad-stealth'

describe('Monad / EVM Stealth Direct Payment Engine (#897)', () => {
  it('derives matching stealth address and private key for secp256k1 (DKSAP)', () => {
    // Generate recipient identity / spend keypair
    const recipientWallet = Wallet.createRandom()
    const recipientSpendSecret = getBytes(recipientWallet.privateKey)
    const recipientSpendPubKey = getBytes(
      SigningKey.computePublicKey(recipientSpendSecret, true),
    )

    // Sender generates ephemeral secret and derives stealth address
    const ephemeralSecret = getBytes(randomBytes(32))
    const senderDerivation = deriveEvmStealthAddress({
      recipientSpendPubKey,
      ephemeralSecret,
    })

    // Recipient uses the ephemeral public key to derive private key and address
    const recipientDerivation = deriveEvmStealthPrivateKey({
      recipientSpendSecret,
      ephemeralPubKey: senderDerivation.ephemeralPubKey,
    })

    // Both must match
    expect(recipientDerivation.stealthAddress.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
    expect(toHex(recipientDerivation.stealthPublicKey)).toBe(
      toHex(senderDerivation.stealthPublicKey),
    )

    // The derived private key must control the stealth address
    const derivedWallet = new Wallet(recipientDerivation.stealthPrivateKey)
    expect(derivedWallet.address.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
  })

  it('rejects invalid public key lengths and secret lengths', () => {
    expect(() =>
      deriveEvmStealthAddress({
        recipientSpendPubKey: new Uint8Array(20),
      }),
    ).toThrow('recipientSpendPubKey must be 33 or 65 bytes')

    expect(() =>
      deriveEvmStealthAddress({
        recipientSpendPubKey: new Uint8Array(33),
        ephemeralSecret: new Uint8Array(16),
      }),
    ).toThrow('ephemeralSecret must be 32 bytes')

    expect(() =>
      deriveEvmStealthPrivateKey({
        recipientSpendSecret: new Uint8Array(16),
        ephemeralPubKey: new Uint8Array(33),
      }),
    ).toThrow('recipientSpendSecret must be 32 bytes')
  })

  it('signs and verifies a message using the derived stealth private key', async () => {
    const recipientWallet = Wallet.createRandom()
    const recipientSpendSecret = getBytes(recipientWallet.privateKey)
    const recipientSpendPubKey = getBytes(
      SigningKey.computePublicKey(recipientSpendSecret, true),
    )

    const senderDerivation = deriveEvmStealthAddress({
      recipientSpendPubKey,
    })

    const recipientDerivation = deriveEvmStealthPrivateKey({
      recipientSpendSecret,
      ephemeralPubKey: senderDerivation.ephemeralPubKey,
    })

    const stealthWallet = new Wallet(recipientDerivation.stealthPrivateKey)
    const message = 'Hello stealth transfer'
    const signature = await stealthWallet.signMessage(message)
    const recovered = verifyMessage(message, signature)

    expect(recovered.toLowerCase()).toBe(
      senderDerivation.stealthAddress.toLowerCase(),
    )
  })

  describe('MonadStealthKeyring', () => {
    it('registers and retrieves stealth accounts idempotently', async () => {
      const keyring = new MonadStealthKeyring()

      const record = {
        address: '0x1111111111111111111111111111111111111111',
        privateKey: '0x' + '22'.repeat(32),
        ephemeralPubKey: '0x02' + '33'.repeat(32),
        networkTag: 'MONT',
        discoveredAtMs: 123456,
        initialAmountWei: 10_000n,
      }

      expect(keyring.hasAccount(record.address)).toBe(false)
      const added = await keyring.addAccount(record)
      expect(added).toBe(true)
      expect(keyring.hasAccount(record.address)).toBe(true)
      expect(keyring.getAccount(record.address)?.privateKey).toBe(
        record.privateKey,
      )

      // Duplicate registration returns false
      const addedAgain = await keyring.addAccount(record)
      expect(addedAgain).toBe(false)

      expect(keyring.getAccounts('MONT')).toHaveLength(1)
      expect(keyring.getAccounts('OTHER')).toHaveLength(0)
    })

    it('aggregates balances across registered stealth accounts', async () => {
      const keyring = new MonadStealthKeyring()
      await keyring.addAccount({
        address: '0x1111111111111111111111111111111111111111',
        privateKey: '0x' + '11'.repeat(32),
        ephemeralPubKey: '0x02' + '11'.repeat(32),
        networkTag: 'MONT',
        discoveredAtMs: 100,
      })
      await keyring.addAccount({
        address: '0x2222222222222222222222222222222222222222',
        privateKey: '0x' + '22'.repeat(32),
        ephemeralPubKey: '0x02' + '22'.repeat(32),
        networkTag: 'MONT',
        discoveredAtMs: 200,
      })

      const mockBalances = new Map<string, bigint>([
        ['0x1111111111111111111111111111111111111111', 5_000n],
        ['0x2222222222222222222222222222222222222222', 15_000n],
      ])

      const mockProvider = {
        getBalance: jest.fn(async (addr: string) => {
          return mockBalances.get(addr.toLowerCase()) ?? 0n
        }),
      } as any

      const total = await keyring.getTotalBalance(mockProvider, 'MONT')
      expect(total).toBe(20_000n)
    })

    it('selects an account with sufficient balance for outbound spend', async () => {
      const keyring = new MonadStealthKeyring()
      await keyring.addAccount({
        address: '0x1111111111111111111111111111111111111111',
        privateKey: '0x' + '11'.repeat(32),
        ephemeralPubKey: '0x02' + '11'.repeat(32),
        networkTag: 'MONT',
        discoveredAtMs: 100,
      })
      await keyring.addAccount({
        address: '0x2222222222222222222222222222222222222222',
        privateKey: '0x' + '22'.repeat(32),
        ephemeralPubKey: '0x02' + '22'.repeat(32),
        networkTag: 'MONT',
        discoveredAtMs: 200,
      })

      const mockBalances = new Map<string, bigint>([
        ['0x1111111111111111111111111111111111111111', 2_000n],
        ['0x2222222222222222222222222222222222222222', 10_000n],
      ])

      const mockProvider = {
        getBalance: jest.fn(async (addr: string) => {
          return mockBalances.get(addr.toLowerCase()) ?? 0n
        }),
      } as any

      const selected = await keyring.selectAccountForSpend(
        8_000n,
        mockProvider,
        'MONT',
      )
      expect(selected?.address.toLowerCase()).toBe(
        '0x2222222222222222222222222222222222222222',
      )

      const none = await keyring.selectAccountForSpend(
        50_000n,
        mockProvider,
        'MONT',
      )
      expect(none).toBeUndefined()
    })
  })

  describe('buildEvmStealthPayment', () => {
    it('derives stealth address, signs transfer, submits transaction, and creates StealthItem', async () => {
      const recipient = Wallet.createRandom()
      const recipientSpendPubKey = getBytes(
        SigningKey.computePublicKey(recipient.privateKey, true),
      )

      const submitted: string[] = []
      const mockHttpClient = {
        submitRawTransaction: jest.fn(async (raw: string) => {
          const hash = '0x' + 'aa'.repeat(32)
          submitted.push(hash)
          return hash
        }),
        destroy: jest.fn(),
      }

      const mockProvider = {
        _perform: jest.fn(async (req: { method: string }) => {
          if (req.method === 'getTransactionCount') return 0
          if (req.method === 'estimateGas') return 21_000n
          if (req.method === 'getGasPrice') return 1n
          if (req.method === 'getPriorityFee') return 1n
          if (req.method === 'getBalance') return 10n ** 18n
          throw new Error(`Unexpected method: ${req.method}`)
        }),
        getBalance: jest.fn(async () => 10n ** 18n),
        estimateGas: jest.fn(async () => 21_000n),
        getFeeData: jest.fn(async () => ({
          gasPrice: 1n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })),
        getTransactionCount: jest.fn(async () => 0),
        getNetwork: jest.fn(async () => ({ chainId: 10143n })),
      } as any

      const senderWallet = Wallet.createRandom()
      const walletHandle = {
        mainAccount: senderWallet,
        provider: mockProvider,
        httpClient: mockHttpClient,
        stealthKeyring: new MonadStealthKeyring(),
      } as any

      const result = await buildEvmStealthPayment({
        wallet: walletHandle,
        recipientSpendPubKey,
        amountWei: 1_000_000n,
        networkTag: 'MONT',
        memo: 'secret coffee',
      })

      expect(mockHttpClient.submitRawTransaction).toHaveBeenCalled()
      expect(result.txHash).toBe('0x' + 'aa'.repeat(32))
      expect(result.stealthItem).toEqual({
        type: 'stealth',
        networkTag: 'MONT',
        keyType: 1,
        ephemeralPubKey: toHex(result.stealthDestination.ephemeralPubKey),
        transactions: ['0x' + 'aa'.repeat(32)],
        amount: 1_000_000,
        memo: 'secret coffee',
        chainId: 'MONT',
      })

      // Recipient can now derive the private key from the StealthItem
      const recipientDerivation = deriveEvmStealthPrivateKey({
        recipientSpendSecret: getBytes(recipient.privateKey),
        ephemeralPubKey: fromHex(result.stealthItem.ephemeralPubKey!),
      })

      expect(recipientDerivation.stealthAddress.toLowerCase()).toBe(
        result.stealthDestination.stealthAddress.toLowerCase(),
      )
    })
  })

  describe('EVM Stealth Keyring & Spend Selection without sweeping', () => {
    it('indexes received stealth payment into keyring and spends directly from it when main account has 0 balance', async () => {
      // 1. Bob's wallet setup
      const bobWallet = Wallet.createRandom()
      const bobSpendSecret = getBytes(bobWallet.privateKey)
      const bobSpendPubKey = getBytes(
        SigningKey.computePublicKey(bobSpendSecret, true),
      )

      // 2. Alice sends 50,000 wei to Bob's stealth address
      const stealthDestination = deriveEvmStealthAddress({
        recipientSpendPubKey: bobSpendPubKey,
      })
      const stealthAddress = stealthDestination.stealthAddress

      // 3. Recipient receives stealth item (e.g. from DM)
      const stealthItem = {
        type: 'stealth' as const,
        networkTag: 'MONT',
        keyType: 1 as const,
        ephemeralPubKey: toHex(stealthDestination.ephemeralPubKey),
        transactions: ['0x' + '33'.repeat(32)],
        amount: 50_000,
        memo: 'stealth transfer',
      }

      // 4. Bob's wallet derives the stealth private key and registers into keyring
      const bobKeyring = new MonadStealthKeyring()
      const derived = deriveEvmStealthPrivateKey({
        recipientSpendSecret: bobSpendSecret,
        ephemeralPubKey: fromHex(stealthItem.ephemeralPubKey),
      })
      await bobKeyring.addAccount({
        address: derived.stealthAddress,
        privateKey: derived.stealthPrivateKey,
        ephemeralPubKey: stealthItem.ephemeralPubKey,
        networkTag: stealthItem.networkTag,
        discoveredAtMs: 1000,
        initialAmountWei: BigInt(stealthItem.amount),
        txHash: stealthItem.transactions[0],
      })

      expect(bobKeyring.hasAccount(stealthAddress)).toBe(true)

      // 5. Mock provider where Bob's main account has 0 balance, but stealth address has 50,000 wei
      const mockBalances = new Map<string, bigint>([
        [bobWallet.address.toLowerCase(), 0n],
        [stealthAddress.toLowerCase(), 50_000n],
      ])

      const mockProvider = {
        _perform: jest.fn(async (req: { method: string; address?: string }) => {
          if (req.method === 'getBalance') {
            return mockBalances.get(req.address!.toLowerCase()) ?? 0n
          }
          if (req.method === 'getTransactionCount') return 0
          if (req.method === 'estimateGas') return 21_000n
          if (req.method === 'getGasPrice') return 1n
          if (req.method === 'getPriorityFee') return 1n
          throw new Error(`unexpected call ${req.method}`)
        }),
        getBalance: jest.fn(async (addr: string) => mockBalances.get(addr.toLowerCase()) ?? 0n),
        estimateGas: jest.fn(async () => 21_000n),
        getFeeData: jest.fn(async () => ({
          gasPrice: 1n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        })),
        getTransactionCount: jest.fn(async () => 0),
        getNetwork: jest.fn(async () => ({ chainId: 10143n })),
      } as any

      // Check total aggregated balance
      const mainBal = await mockProvider.getBalance(bobWallet.address)
      const stealthBal = await bobKeyring.getTotalBalance(mockProvider, 'MONT')
      const totalBalance = mainBal + stealthBal
      expect(totalBalance).toBe(50_000n)

      // 6. Spend outbound from Bob without sweeping first:
      // Coin/account selector picks the funded stealth account because main account has 0 balance!
      const selected = await bobKeyring.selectAccountForSpend(
        30_000n,
        mockProvider,
        'MONT',
      )
      expect(selected).toBeDefined()
      expect(selected!.address.toLowerCase()).toBe(stealthAddress.toLowerCase())
      expect(selected!.privateKey).toBe(derived.stealthPrivateKey)

      // Bob signs an outbound transfer directly from the stealth account!
      const mockHttpClient = {
        submitRawTransaction: jest.fn(async (raw: string) => {
          return '0x' + 'bb'.repeat(32)
        }),
      }

      const signer = new MonadAccountTxSigner({
        privateKey: selected!.privateKey,
        provider: mockProvider,
        httpClient: mockHttpClient as any,
      })

      const charlie = Wallet.createRandom().address
      const signed = await signer.buildAndSignTransfer(charlie, 30_000n)
      const txHash = await mockHttpClient.submitRawTransaction(signed.rawTransaction)

      expect(txHash).toBe('0x' + 'bb'.repeat(32))
      const parsedWallet = new Wallet(selected!.privateKey)
      expect(parsedWallet.address.toLowerCase()).toBe(stealthAddress.toLowerCase())
    })
  })
})
