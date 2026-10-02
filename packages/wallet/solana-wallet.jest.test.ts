import {
  Keypair,
  PublicKey,
  SystemInstruction,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js'

import {
  SolanaStealthAddressStrategy,
  SolanaStealthUnavailableError,
  SolanaWallet,
  SolanaWalletConnection,
} from './solana-wallet'
import { TransactionBundleSubmissionError } from './transaction-bundle-wallet'

const blockhash = new PublicKey(new Uint8Array(32).fill(9)).toBase58()

class FakeConnection implements SolanaWalletConnection {
  balance = 123n
  sent: Uint8Array[] = []
  failAt: number | undefined

  async getBalance(): Promise<bigint> {
    return this.balance
  }

  async getLatestBlockhash() {
    return { blockhash, lastValidBlockHeight: 456n }
  }

  async sendRawTransaction(rawTransaction: Uint8Array): Promise<string> {
    const index = this.sent.length
    if (index === this.failAt) throw new Error('rpc refused transaction')
    this.sent.push(rawTransaction)
    return `signature-${index}`
  }
}

async function makeKeypair(byte: number): Promise<Keypair> {
  return Keypair.fromSeed(new Uint8Array(32).fill(byte))
}

describe('SolanaWallet', () => {
  it('builds and signs an ordered native-transfer bundle', async () => {
    const connection = new FakeConnection()
    const signer = await makeKeypair(1)
    const destinations = [await makeKeypair(2), await makeKeypair(3)]
    const wallet = new SolanaWallet({ connection, signer })

    const bundle = await wallet.buildTransactionBundle({
      transfers: destinations.map((destination, index) => ({
        destination: destination.publicKey,
        lamports: BigInt(index + 10),
      })),
    })

    expect(bundle.source).toBe(signer.publicKey.toBase58())
    expect(bundle.recentBlockhash).toBe(blockhash)
    expect(bundle.lastValidBlockHeight).toBe(456n)
    expect(bundle.transactions).toHaveLength(2)
    for (const [index, bundled] of bundle.transactions.entries()) {
      const transaction = VersionedTransaction.deserialize(
        bundled.rawTransaction,
      )
      expect(transaction.signatures[0]).not.toEqual(new Uint8Array(64))
      const message = TransactionMessage.decompile(transaction.message)
      const transfer = SystemInstruction.decodeTransfer(message.instructions[0])
      expect(transfer.fromPubkey.equals(signer.publicKey)).toBe(true)
      expect(transfer.toPubkey.equals(destinations[index].publicKey)).toBe(true)
      expect(BigInt(transfer.lamports)).toBe(BigInt(index + 10))
    }
  })

  it('builds distinct strategy-owned stealth destinations with metadata', async () => {
    const connection = new FakeConnection()
    const derived = [await makeKeypair(4), await makeKeypair(5)]
    const contexts: Uint8Array[] = []
    const strategy: SolanaStealthAddressStrategy<{ child: number }> = {
      async createDestination({ paymentIndex, context }) {
        contexts.push(context)
        return {
          address: derived[paymentIndex].publicKey,
          metadata: { child: paymentIndex },
        }
      },
    }
    const wallet = new SolanaWallet({
      connection,
      signer: await makeKeypair(1),
      stealthStrategy: strategy,
    })
    const context = Uint8Array.from([1, 2, 3])

    const bundle = await wallet.buildStealthTransactionBundle({
      recipient: (await makeKeypair(8)).publicKey,
      lamports: [20n, 30n],
      context,
    })
    context[0] = 99

    expect(bundle.transactions.map(tx => tx.destination)).toEqual(
      derived.map(keypair => keypair.publicKey.toBase58()),
    )
    expect(bundle.transactions.map(tx => tx.metadata)).toEqual([
      { stealth: { child: 0 } },
      { stealth: { child: 1 } },
    ])
    expect(contexts.map(value => [...value])).toEqual([
      [1, 2, 3],
      [1, 2, 3],
    ])
  })

  it('refuses stealth transfers without a reviewed strategy', async () => {
    const wallet = new SolanaWallet({
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
    })

    await expect(
      wallet.buildStealthTransactionBundle({
        recipient: (await makeKeypair(2)).publicKey,
        lamports: [1n],
        context: new Uint8Array(),
      }),
    ).rejects.toBeInstanceOf(SolanaStealthUnavailableError)
  })

  it('rejects duplicate destinations returned by a stealth strategy', async () => {
    const destination = (await makeKeypair(7)).publicKey
    const wallet = new SolanaWallet({
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
      stealthStrategy: {
        async createDestination() {
          return { address: destination, metadata: undefined }
        },
      },
    })

    await expect(
      wallet.buildStealthTransactionBundle({
        recipient: (await makeKeypair(2)).publicKey,
        lamports: [1n, 2n],
        context: new Uint8Array(),
      }),
    ).rejects.toThrow('duplicate destinations')
  })

  it('reports the submitted prefix when bundle submission fails', async () => {
    const connection = new FakeConnection()
    connection.failAt = 1
    const wallet = new SolanaWallet({
      connection,
      signer: await makeKeypair(1),
    })
    const bundle = await wallet.buildTransactionBundle({
      transfers: [2, 3].map(byte => ({
        destination: new PublicKey(new Uint8Array(32).fill(byte)),
        lamports: 1n,
      })),
    })

    let error: unknown
    try {
      await wallet.submitTransactionBundle(bundle)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TransactionBundleSubmissionError)
    const submissionError = error as TransactionBundleSubmissionError<string>
    expect(submissionError.failedIndex).toBe(1)
    expect(submissionError.submitted).toEqual([
      expect.objectContaining({ index: 0, txId: 'signature-0' }),
    ])
  })

  it('returns balances as bigint', async () => {
    const wallet = new SolanaWallet({
      connection: new FakeConnection(),
      signer: await makeKeypair(1),
    })
    await expect(wallet.getBalance()).resolves.toBe(123n)
  })
})
