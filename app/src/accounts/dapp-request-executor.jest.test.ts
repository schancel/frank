import { HDNodeWallet, Transaction, Wallet, verifyMessage } from 'ethers'
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js'
import { ed25519 } from '@noble/curves/ed25519'
import { deriveDappPersona } from '@frank/wallet/dapp-bridge/persona-keys'
import { PROTOCOL_CHAINS } from '@frank/wallet/chain'
import {
  createConfiguredDappEvmRpc,
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
    append: async attempt => {
      attempts = [...attempts, attempt]
    },
  }
  return { store, getAttempts: () => attempts }
}

function injectedEvmRpc(chainIds: string[] = []) {
  return async (chainIdentifier: string) => {
    chainIds.push(chainIdentifier)
    return {
      async send(method: string, params: unknown[]) {
        const response = await (global.fetch as any)('https://rpc.test', {
          body: JSON.stringify({ method, params }),
        })
        const body = await response.json()
        if (body.error) throw new Error(body.error.message)
        return body.result
      },
    }
  }
}

describe('approved dApp request executor', () => {
  it('routes EVM RPC through the canonical registry endpoint and verifies chain identity first', async () => {
    const originalFetch = global.fetch
    const entry = PROTOCOL_CHAINS['monad-testnet']
    const checkpoint = entry.identityProbes.find(
      probe => probe.kind === 'block-hash',
    )
    if (!checkpoint || checkpoint.kind !== 'block-hash')
      throw new Error('fixture checkpoint missing')
    const calls: string[] = []
    global.fetch = jest.fn(async (url: any, init: any) => {
      expect(url).toBe(entry.rpcUrls?.[0])
      const call = JSON.parse(init.body)
      calls.push(call.method)
      const result =
        call.method === 'eth_chainId'
          ? '0x279f'
          : call.method === 'eth_getBlockByNumber'
          ? { hash: checkpoint.expected }
          : null
      return { ok: true, json: async () => ({ result }) } as any
    }) as any
    try {
      const rpc = await createConfiguredDappEvmRpc('monad-testnet')
      expect(calls).toEqual(['eth_chainId', 'eth_getBlockByNumber'])
      expect(await rpc.send('eth_getBlockByNumber', ['0x0', false])).toEqual({
        hash: checkpoint.expected,
      })
    } finally {
      global.fetch = originalFetch
    }
  })

  it('refuses EVM signing RPC when registry chain identity does not match', async () => {
    const originalFetch = global.fetch
    let calls = 0
    global.fetch = jest.fn(async () => {
      calls += 1
      return { ok: true, json: async () => ({ result: '0x1' }) } as any
    }) as any
    try {
      await expect(createConfiguredDappEvmRpc('monad-testnet')).rejects.toThrow(
        'identity mismatch',
      )
      expect(calls).toBe(1)
    } finally {
      global.fetch = originalFetch
    }
  })

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
    const chainIds: string[] = []
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
        { attemptStore: attemptStore.store, evmRpc: injectedEvmRpc(chainIds) },
      )
      expect(hash).toMatch(/^0x[0-9a-f]{64}$/i)
      expect(methods).toEqual([
        'eth_getTransactionCount',
        'eth_estimateGas',
        'eth_gasPrice',
        'eth_sendRawTransaction',
      ])
      expect(attemptStore.getAttempts()).toHaveLength(1)
      expect(chainIds).toEqual(['ethereum-mainnet'])
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
          evmRpc: injectedEvmRpc(),
        }),
      ).rejects.toThrow('timed out')
      expect(attemptStore.getAttempts()).toHaveLength(1)
      const hash = await executeApprovedDappRequest(
        { ...request, id: 'ambiguous-retry-approval' },
        fakeSession(),
        {
          attemptStore: attemptStore.store,
          evmRpc: injectedEvmRpc(),
        },
      )
      expect(hash).toBe(attemptStore.getAttempts()[0]?.transactionHash)
      expect(sendCalls).toBe(2)
      expect(attemptStore.getAttempts()).toHaveLength(1)
    } finally {
      global.fetch = originalFetch
    }
  })

  it.each(['0x1', '0x0'])(
    'replays a confirmed EVM intent with receipt status %s without creating another transaction',
    async receiptStatus => {
      const originalFetch = global.fetch
      const attemptStore = memoryAttemptStore()
      const transaction = {
        from: EVM_PERSONA.address,
        to: Wallet.createRandom().address,
        value: '0x3',
      }
      let sendCalls = 0
      let nonceCalls = 0
      global.fetch = jest.fn(async (_url: unknown, init: { body: string }) => {
        const call = JSON.parse(init.body)
        if (call.method === 'eth_getTransactionCount') {
          nonceCalls += 1
          return { json: async () => ({ result: '0x0' }) } as Response
        }
        if (call.method === 'eth_estimateGas')
          return { json: async () => ({ result: '0x5208' }) } as Response
        if (call.method === 'eth_gasPrice')
          return { json: async () => ({ result: '0x3b9aca00' }) } as Response
        if (call.method === 'eth_sendRawTransaction') {
          sendCalls += 1
          return {
            json: async () => ({
              result: Transaction.from(call.params[0]).hash,
            }),
          } as Response
        }
        if (call.method === 'eth_getTransactionReceipt')
          return {
            json: async () => ({ result: { status: receiptStatus } }),
          } as Response
        throw new Error(`unexpected RPC ${call.method}`)
      }) as typeof fetch
      try {
        const request = {
          id: `confirmed-${receiptStatus}`,
          origin: ORIGIN,
          method: 'eth_sendTransaction',
          params: [transaction],
          chainIdHex: '0x1',
          personaRef: REF,
          personaAddress: EVM_PERSONA.address,
        }
        const firstHash = await executeApprovedDappRequest(
          request,
          fakeSession(),
          {
            attemptStore: attemptStore.store,
            evmRpc: injectedEvmRpc(),
          },
        )
        const replayHash = await executeApprovedDappRequest(
          request,
          fakeSession(),
          {
            attemptStore: attemptStore.store,
            evmRpc: injectedEvmRpc(),
          },
        )
        expect(replayHash).toBe(firstHash)
        expect(sendCalls).toBe(1)
        expect(nonceCalls).toBe(1)
        expect(attemptStore.getAttempts()).toHaveLength(1)
      } finally {
        global.fetch = originalFetch
      }
    },
  )

  it('treats a separately approved identical EVM send as a new operation', async () => {
    const attemptStore = memoryAttemptStore()
    const transaction = {
      from: EVM_PERSONA.address,
      to: Wallet.createRandom().address,
      value: '0x4',
    }
    let nonce = 0
    let sends = 0
    const evmRpc = async () => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_getTransactionCount') return `0x${nonce++}`
        if (method === 'eth_getTransactionReceipt') return { status: '0x1' }
        if (method === 'eth_estimateGas') return '0x5208'
        if (method === 'eth_gasPrice') return '0x3b9aca00'
        if (method === 'eth_sendRawTransaction') {
          sends += 1
          return Transaction.from(params[0] as string).hash
        }
        throw new Error(`unexpected RPC ${method}`)
      },
    })
    const createRequest = (id: string) => ({
      id,
      origin: ORIGIN,
      method: 'eth_sendTransaction',
      params: [transaction],
      chainIdHex: '0x1',
      personaRef: REF,
      personaAddress: EVM_PERSONA.address,
    })
    const firstHash = await executeApprovedDappRequest(
      createRequest('approved-send-1'),
      fakeSession(),
      { attemptStore: attemptStore.store, evmRpc },
    )
    const secondHash = await executeApprovedDappRequest(
      createRequest('approved-send-2'),
      fakeSession(),
      { attemptStore: attemptStore.store, evmRpc },
    )

    expect(secondHash).not.toBe(firstHash)
    expect(sends).toBe(2)
    expect(attemptStore.getAttempts()).toHaveLength(2)
    expect(
      attemptStore.getAttempts().map(attempt => attempt.requestId),
    ).toEqual(['approved-send-1', 'approved-send-2'])
  })

  it('serializes different EVM intents for the same chain and account', async () => {
    const attemptStore = memoryAttemptStore()
    const sentTransactions: string[] = []
    let nonceCalls = 0
    let signatureCalls = 0
    const session = fakeSession()
    const originalCreateSigner = session.createDappPersonaSigner
    session.createDappPersonaSigner = async () => {
      const signer = await originalCreateSigner()
      const originalSign = signer.signDigest
      signer.signDigest = async (...args: any[]) => {
        signatureCalls += 1
        return originalSign(...args)
      }
      return signer
    }
    const evmRpc = async () => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_getTransactionCount') {
          nonceCalls += 1
          return '0x0'
        }
        if (method === 'eth_estimateGas') return '0x5208'
        if (method === 'eth_gasPrice') return '0x3b9aca00'
        if (method === 'eth_sendRawTransaction') {
          sentTransactions.push(params[0] as string)
          return Transaction.from(params[0] as string).hash
        }
        if (method === 'eth_getTransactionReceipt') return null
        throw new Error(`unexpected RPC ${method}`)
      },
    })
    const request = (id: string, value: string) => ({
      id,
      origin: ORIGIN,
      method: 'eth_sendTransaction',
      params: [
        {
          from: EVM_PERSONA.address,
          to: Wallet.createRandom().address,
          value,
        },
      ],
      chainIdHex: '0x1',
      personaRef: REF,
      personaAddress: EVM_PERSONA.address,
    })

    const results = await Promise.allSettled([
      executeApprovedDappRequest(request('concurrent-a', '0x10'), session, {
        attemptStore: attemptStore.store,
        evmRpc,
      }),
      executeApprovedDappRequest(request('concurrent-b', '0x20'), session, {
        attemptStore: attemptStore.store,
        evmRpc,
      }),
    ])

    expect(
      results.filter(result => result.status === 'fulfilled'),
    ).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(
      1,
    )
    expect(nonceCalls).toBe(2)
    expect(signatureCalls).toBe(1)
    expect(sentTransactions).toHaveLength(1)
    expect(attemptStore.getAttempts()).toHaveLength(1)
  })

  it('admits a different chain while one chain/account RPC is waiting', async () => {
    const attemptStore = memoryAttemptStore()
    let releaseFirstNonce!: () => void
    let markFirstNonceStarted!: () => void
    const firstNonceStarted = new Promise<void>(resolve => {
      markFirstNonceStarted = resolve
    })
    const firstNonceGate = new Promise<void>(resolve => {
      releaseFirstNonce = resolve
    })
    const evmRpc = async (chainIdentifier: string) => ({
      async send(method: string, params: unknown[]) {
        if (method === 'eth_getTransactionCount') {
          if (chainIdentifier === 'ethereum-mainnet') {
            markFirstNonceStarted()
            await firstNonceGate
          }
          return '0x0'
        }
        if (method === 'eth_estimateGas') return '0x5208'
        if (method === 'eth_gasPrice') return '0x3b9aca00'
        if (method === 'eth_sendRawTransaction')
          return Transaction.from(params[0] as string).hash
        throw new Error(`unexpected RPC ${method}`)
      },
    })
    const request = (id: string, chainIdHex: string) => ({
      id,
      origin: ORIGIN,
      method: 'eth_sendTransaction',
      params: [
        {
          from: EVM_PERSONA.address,
          to: Wallet.createRandom().address,
          value: '0x1',
        },
      ],
      chainIdHex,
      personaRef: REF,
      personaAddress: EVM_PERSONA.address,
    })

    const first = executeApprovedDappRequest(
      request('chain-a', '0x1'),
      fakeSession(),
      { attemptStore: attemptStore.store, evmRpc },
    )
    await firstNonceStarted
    const second = executeApprovedDappRequest(
      request('chain-b', '0x279f'),
      fakeSession(),
      { attemptStore: attemptStore.store, evmRpc },
    )
    await expect(second).resolves.toMatch(/^0x[0-9a-f]{64}$/i)
    releaseFirstNonce()
    await expect(first).resolves.toMatch(/^0x[0-9a-f]{64}$/i)
    expect(attemptStore.getAttempts()).toHaveLength(2)
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
        solanaAccountAddress: account.address,
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

  it('refuses to sign when the Solana account changes after approval preview, even without params.account', async () => {
    const otherKey = await Keypair.fromSeed(new Uint8Array(32).fill(42))
    const signMessage = jest.fn(async () => new Uint8Array(64))
    const session = fakeSession()
    session.createDappSolanaSigner = async () => ({
      publicKey: otherKey.publicKey.toBase58(),
      signMessage,
      signTransaction: async (bytes: Uint8Array) => bytes,
    })

    await expect(
      executeApprovedDappRequest(
        {
          id: 'sol-account-switch',
          origin: ORIGIN,
          method: 'solana_signMessage',
          params: { message: [1, 2, 3] },
          solanaAccountAddress: SOLANA_KEY.publicKey.toBase58(),
        },
        session,
      ),
    ).rejects.toThrow('approved Solana account changed')
    expect(signMessage).not.toHaveBeenCalled()
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
          solanaAccountAddress: SOLANA_KEY.publicKey.toBase58(),
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
