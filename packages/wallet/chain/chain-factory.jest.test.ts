import { Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js'
import { getBase58Decoder } from '@solana/codecs-strings'

import { createChain } from './chain-factory'
import { NativeAssetChain } from './active-chain'
import { EcashWalletBackend } from '../ecash-wallet'
import { SolanaWalletConnection } from '../solana-wallet'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'

const ECASH_ADDRESS = 'ecash:qq86jv6h0y97q8l63ndynvk3fn9aq8fqru3exew8gl'
const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SOLANA_BLOCKHASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58()
const base58Decoder = getBase58Decoder()

function exerciseCodecs(chain: NativeAssetChain, address: string): void {
  const parsed = chain.parseAddress(address)
  expect(parsed).toBeDefined()
  expect(chain.addressToString(parsed!)).toBe(address)
  expect(chain.formatAddress(parsed!)).toBe(address)
  expect(chain.transactionToString({ txHash: 'tx-id' })).toBe('tx-id')
  expect(chain.fromDisplayAmount(chain.toDisplayAmount(123n))).toBe(123n)
}

describe('createChain', () => {
  it('creates a Solana chain with the shared codecs and wallet API', async () => {
    const signer = await Keypair.fromSeed(new Uint8Array(32).fill(1))
    const recipient = (await Keypair.fromSeed(new Uint8Array(32).fill(2)))
      .publicKey
    const sent: Uint8Array[] = []
    const connection: SolanaWalletConnection = {
      async getBalance() {
        return 99n
      },
      async getLatestBlockhash() {
        return { blockhash: SOLANA_BLOCKHASH, lastValidBlockHeight: 1n }
      },
      async sendRawTransaction(raw) {
        sent.push(raw)
        return base58Decoder.decode(
          VersionedTransaction.deserialize(raw).signatures[0],
        )
      },
    }
    const chain = await createChain({
      kind: 'solana',
      config: {
        networkId: 'solana-test',
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        connection,
        deriveSigner: () => signer,
      },
    })
    exerciseCodecs(chain, recipient.toBase58())
    expect(chain.toDisplayAmount(1_500_000_000n)).toBe('1.5')
    expect(chain.fromDisplayAmount('1.5')).toBe(1_500_000_000n)

    const wallet = await chain.createWallet({ mnemonic: MNEMONIC })
    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      99n,
    )
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: { raw: recipient.toBase58() },
        value: 7n,
      }),
    ).resolves.toEqual({ txHash: expect.any(String) })
    expect(sent).toHaveLength(1)

    const otherNetwork = await createChain({
      kind: 'solana',
      config: {
        networkId: 'solana-mainnet',
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        connection,
        deriveSigner: () => signer,
      },
    })
    await expect(
      otherNetwork.nativeTransfers.getBalance({ wallet }),
    ).rejects.toThrow('Expected Solana network solana-mainnet, got solana-test')
    await expect(
      otherNetwork.nativeTransfers.send({
        wallet,
        recipient: { raw: recipient.toBase58() },
        value: 7n,
      }),
    ).rejects.toThrow('Expected Solana network solana-mainnet, got solana-test')
    expect(sent).toHaveLength(1)
  })

  it('creates an eCash chain without exposing UTXO machinery', async () => {
    const broadcast = jest.fn().mockResolvedValue({
      success: true,
      broadcasted: ['xec-tx'],
    })
    const backend: EcashWalletBackend = {
      balanceSats: 500n,
      receiveIndex: 0,
      sync: jest.fn().mockResolvedValue(undefined),
      syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
      getReceiveAddress: () => ECASH_ADDRESS,
      action: () => ({
        build: () => ({ builtTxs: [{ txid: 'xec-tx' }], broadcast }),
      }),
    }
    const chain = await createChain({
      kind: 'ecash',
      config: {
        networkId: 'ecash-test',
        nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
        chronik: {},
        walletFactory: () => backend,
      },
    })
    exerciseCodecs(chain, ECASH_ADDRESS)
    expect(chain.toDisplayAmount(123n)).toBe('1.23')
    expect(chain.fromDisplayAmount('1.23')).toBe(123n)
    expect(() => chain.fromDisplayAmount('1.234')).toThrow(
      'at most 2 decimal places',
    )

    const wallet = await chain.createWallet({ mnemonic: MNEMONIC })
    await expect(chain.nativeTransfers.getBalance({ wallet })).resolves.toBe(
      500n,
    )
    await expect(
      chain.nativeTransfers.send({
        wallet,
        recipient: { raw: ECASH_ADDRESS },
        value: 100n,
      }),
    ).resolves.toEqual({ txHash: 'xec-tx' })
    expect('buildTransactionBundle' in wallet).toBe(false)
  })

  it('rejects a wallet created for another chain', async () => {
    const chain = await createChain({
      kind: 'ecash',
      config: {
        networkId: 'ecash-test',
        chronik: {},
        walletFactory: () => ({
          balanceSats: 0n,
          receiveIndex: 0,
          sync: jest.fn().mockResolvedValue(undefined),
          syncAndDiscoverAddresses: jest.fn().mockResolvedValue(undefined),
          getReceiveAddress: () => ECASH_ADDRESS,
          action: () => {
            throw new Error('must not build')
          },
        }),
      },
    })
    const foreignWallet = {
      chainKind: 'solana' as const,
      networkId: 'solana-test',
      identity: {
        address: { raw: 'foreign' },
        displayAddress: 'foreign',
      },
      getReceiveAddress: jest.fn(async () => ({ raw: 'foreign' })),
      getUnresolvedNativeTransaction: jest.fn(),
      retryUnresolvedNativeTransaction: jest.fn(),
      resolveUnresolvedNativeTransaction: jest.fn(),
      getBalance: jest.fn().mockResolvedValue(123n),
      sendNative: jest.fn(),
    }

    await expect(
      chain.nativeTransfers.getBalance({ wallet: foreignWallet }),
    ).rejects.toThrow('Expected an eCash wallet, got solana')
    expect(foreignWallet.getBalance).not.toHaveBeenCalled()
  })

  it('accepts a runtime ChainFactoryConfig union', async () => {
    const config: import('./chain-factory').ChainFactoryConfig = {
      kind: 'solana',
      config: {
        networkId: 'solana-test',
        connection: {
          getBalance: async () => 0n,
          getLatestBlockhash: async () => ({
            blockhash: SOLANA_BLOCKHASH,
            lastValidBlockHeight: 1n,
          }),
          sendRawTransaction: async () => 'unused',
        },
        deriveSigner: async () => Keypair.fromSeed(new Uint8Array(32).fill(1)),
      },
    }
    await expect(createChain(config)).resolves.toMatchObject({ kind: 'solana' })
  })
})
