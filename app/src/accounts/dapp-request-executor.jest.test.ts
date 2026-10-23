import { HDNodeWallet, Transaction, Wallet, verifyMessage } from 'ethers'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { deriveDappPersona } from '@frank/wallet/dapp-bridge/persona-keys'
import {
  executeApprovedDappRequest,
  type DappEvmAttempt,
  type DappEvmAttemptStore,
} from './dapp-request-executor'

const ORIGIN = 'https://dapp.example'
const MASTER = HDNodeWallet.fromSeed(new Uint8Array(32).fill(19))
const REF = { kind: 'site' as const, origin: ORIGIN }
const EVM_PERSONA = deriveDappPersona(MASTER, REF)
let SOLANA_KEY: Keypair

beforeAll(async () => {
  SOLANA_KEY = await Keypair.fromSeed(new Uint8Array(32).fill(21))
})

function fakeSession() {
  return {
    createDappPersonaSigner: async () => ({
      accountId: 'fixture',
      addresses: async (refs: readonly any[]) =>
        refs.map(ref => deriveDappPersona(MASTER, ref).address),
      signDigest: async (ref: any, digest: string) =>
        deriveDappPersona(MASTER, ref).node.signingKey.sign(digest).serialized,
    }),
    createDappSolanaSigner: async () => ({
      publicKey: SOLANA_KEY.publicKey.toBase58(),
      signMessage: async (message: Uint8Array) =>
        ed25519.sign(message, SOLANA_KEY.secretKey.slice(0, 32)),
      signTransaction: async (serialized: Uint8Array) => {
        const tx = VersionedTransaction.deserialize(serialized)
        await tx.sign([SOLANA_KEY])
        return tx.serialize()
      },
    }),
  } as any
}

function memoryAttemptStore() {
  let attempts: readonly DappEvmAttempt[] = []
  const store: DappEvmAttemptStore = {
    read: async () => attempts,
    write: async rows => {
      attempts = [...rows]
    },
  }
  return { store, getAttempts: () => attempts }
}

describe('approved dApp request executor', () => {
  it('signs EVM personal messages with the site persona and returns a verifiable signature', async () => {
    const signature = (await executeApprovedDappRequest(
      {
        id: 'sign-1',
        origin: ORIGIN,
        method: 'personal_sign',
        params: ['0x68656c6c6f', EVM_PERSONA.address],
        chainIdHex: '0x1',
        personaRef: REF,
        personaAddress: EVM_PERSONA.address,
      },
      fakeSession(),
    )) as string
    expect(verifyMessage('hello', signature)).toBe(EVM_PERSONA.address)
  })

  it('signs and broadcasts an EVM transaction, returning the matching chain hash', async () => {
    const originalFetch = global.fetch
    const methods: string[] = []
    const attemptStore = memoryAttemptStore()
    const transaction = {
      from: EVM_PERSONA.address,
      to: Wallet.createRandom().address,
      value: '0x1',
    }
    global.fetch = jest.fn(async (_url: any, init: any) => {
      const call = JSON.parse(init.body)
      methods.push(call.method)
      if (call.method === 'eth_getTransactionCount')
        return { ok: true, json: async () => ({ result: '0x0' }) } as any
      if (call.method === 'eth_estimateGas')
        return { ok: true, json: async () => ({ result: '0x5208' }) } as any
      if (call.method === 'eth_gasPrice')
        return { ok: true, json: async () => ({ result: '0x3b9aca00' }) } as any
      if (call.method === 'eth_sendRawTransaction') {
        const tx = Transaction.from(call.params[0])
        expect(tx.from?.toLowerCase()).toBe(EVM_PERSONA.address.toLowerCase())
        return { ok: true, json: async () => ({ result: tx.hash }) } as any
      }
      throw new Error(`unexpected RPC ${call.method}`)
    }) as any
    try {
      const hash = await executeApprovedDappRequest(
        {
          id: 'tx-1',
          origin: ORIGIN,
          method: 'eth_sendTransaction',
          params: [transaction],
          chainIdHex: '0x1',
          personaRef: REF,
          personaAddress: EVM_PERSONA.address,
        },
        fakeSession(),
        { attemptStore: attemptStore.store },
      )
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/i)
      expect(methods).toEqual([
        'eth_getTransactionCount',
        'eth_estimateGas',
        'eth_gasPrice',
        'eth_sendRawTransaction',
      ])
      expect(attemptStore.getAttempts()).toHaveLength(1)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('retries the identical signed EVM transaction after an ambiguous RPC timeout', async () => {
    const originalFetch = global.fetch
    const attemptStore = memoryAttemptStore()
    const transaction = {
      from: EVM_PERSONA.address,
      to: Wallet.createRandom().address,
      value: '0x2',
    }
    let sendCalls = 0
    let firstRaw = ''
    global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
      const call = JSON.parse(init.body)
      if (call.method === 'eth_getTransactionCount')
        return { ok: true, json: async () => ({ result: '0x0' }) } as Response
      if (call.method === 'eth_estimateGas')
        return {
          ok: true,
          json: async () => ({ result: '0x5208' }),
        } as Response
      if (call.method === 'eth_gasPrice')
        return {
          ok: true,
          json: async () => ({ result: '0x3b9aca00' }),
        } as Response
      if (call.method === 'eth_getTransactionReceipt')
        return { ok: true, json: async () => ({ result: null }) } as Response
      if (call.method === 'eth_sendRawTransaction') {
        sendCalls += 1
        if (sendCalls === 1) {
          firstRaw = call.params[0]
          throw new Error('RPC response timed out after submission')
        }
        expect(call.params[0]).toBe(firstRaw)
        return {
          ok: true,
          json: async () => ({ result: Transaction.from(call.params[0]).hash }),
        } as Response
      }
      throw new Error(`unexpected RPC ${call.method}`)
    }) as typeof fetch
    try {
      const request = {
        id: 'ambiguous-1',
        origin: ORIGIN,
        method: 'eth_sendTransaction',
        params: [transaction],
        chainIdHex: '0x1',
        personaRef: REF,
        personaAddress: EVM_PERSONA.address,
      }
      await expect(
        executeApprovedDappRequest(request, fakeSession(), {
          attemptStore: attemptStore.store,
        }),
      ).rejects.toThrow('timed out')
      expect(attemptStore.getAttempts()).toHaveLength(1)
      const hash = await executeApprovedDappRequest(request, fakeSession(), {
        attemptStore: attemptStore.store,
      })
      expect(hash).toBe(attemptStore.getAttempts()[0]?.transactionHash)
      expect(sendCalls).toBe(2)
      expect(attemptStore.getAttempts()).toHaveLength(1)
    } finally {
      global.fetch = originalFetch
    }
  })

  it('returns the actual Solana key and signs a message with its matching Ed25519 key', async () => {
    const account = (await executeApprovedDappRequest(
      {
        id: 'sol-connect',
        origin: ORIGIN,
        method: 'solana_connect',
        params: {},
      },
      fakeSession(),
    )) as { address: string; publicKey: number[] }
    expect(account.address).toBe(SOLANA_KEY.publicKey.toBase58())
    expect(account.publicKey).toEqual(
      Array.from(SOLANA_KEY.publicKey.toBytes()),
    )
    const message = new Uint8Array([9, 8, 7])
    const result = (await executeApprovedDappRequest(
      {
        id: 'sol-sign',
        origin: ORIGIN,
        method: 'solana_signMessage',
        params: { message: Array.from(message), account: account.address },
      },
      fakeSession(),
    )) as { signature: number[] }
    expect(
      ed25519.verify(
        Uint8Array.from(result.signature),
        message,
        Uint8Array.from(account.publicKey),
      ),
    ).toBe(true)
  })

  it('signs and submits a serialized Solana transfer through the configured chain RPC', async () => {
    const destination = (
      await Keypair.fromSeed(new Uint8Array(32).fill(22))
    ).publicKey.toBytes()
    const blockhash = new Uint8Array(32).fill(4)
    const transferData = new Uint8Array(12)
    transferData.set([2, 0, 0, 0], 0)
    transferData[4] = 1
    const message = new Uint8Array([
      0x80, // v0 message
      1,
      0,
      1, // header: one signer, one readonly unsigned program
      3,
      ...SOLANA_KEY.publicKey.toBytes(),
      ...destination,
      ...new Uint8Array(32), // account keys
      ...blockhash,
      1, // instruction count
      2, // system program account index
      2,
      0,
      1, // signer and destination account indexes
      transferData.length,
      ...transferData,
      0, // address table lookup count
    ])
    const unsigned = new Uint8Array([1, ...new Uint8Array(64), ...message])
    const genesis = jest
      .spyOn(Connection.prototype, 'getGenesisHash')
      .mockResolvedValue('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG')
    const send = jest
      .spyOn(Connection.prototype, 'sendRawTransaction')
      .mockImplementation(async bytes => {
        const tx = VersionedTransaction.deserialize(bytes)
        expect(
          ed25519.verify(
            tx.signatures[0]!,
            tx.message.serialize(),
            SOLANA_KEY.publicKey.toBytes(),
          ),
        ).toBe(true)
        const { default: bs58 } = await import('bs58')
        return bs58.encode(tx.signatures[0]!)
      })
    try {
      const signature = await executeApprovedDappRequest(
        {
          id: 'sol-send',
          origin: ORIGIN,
          method: 'solana_signAndSendTransaction',
          params: {
            transaction: Array.from(unsigned),
            account: SOLANA_KEY.publicKey.toBase58(),
            chain: 'solana:devnet',
          },
        },
        fakeSession(),
      )
      expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/)
      expect(send).toHaveBeenCalledTimes(1)
    } finally {
      send.mockRestore()
      genesis.mockRestore()
    }
  })
})
