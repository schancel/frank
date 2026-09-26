/**
 * Unit tests for `monad-account-tx.ts`, against a mocked ethers `Provider` (for nonce/gas/fee/
 * chainId reads) and a mocked `MonadTxSubmitter` (the `MonadHttpClient` surface this module uses
 * for submit/track).
 *
 * NOT CURRENTLY RUN: this repo's `jest.config.js`/`package.json` reference `jest`, but `jest`
 * (and `ts-jest`, `@types/jest`, etc.) are not actually installed as dependencies — confirmed by
 * `grep -n '"jest"' package.json` returning nothing and `node_modules/jest` not existing after a
 * clean `yarn install` (same finding as ticket #17's `monad-http.smoketest.ts` header references).
 * This file follows `jest.config.js`'s own `testMatch` convention
 * (`src/**\/*.jest.(spec|test).ts`) so it will be picked up automatically, unmodified, the moment
 * jest is added as a real dependency. Until then:
 *   - `describe`/`it`/`expect`/`jest` below are untyped/unrun; `@typescript-eslint`'s `no-undef`
 *     is not part of this project's eslint config for TS files (TS itself would normally catch
 *     an undefined global, but `env: { jest: true }` in `.eslintrc.js` tells eslint's own checks
 *     to treat these as known globals — see that file).
 *   - Every scenario here is also exercised for real, right now, without jest, by
 *     `monad-account-tx.livecheck.ts` in this same directory (run via `tsc`+`node`, no mocking
 *     framework needed) — see that file's header for how to run it and its output.
 *
 * Mocking approach: `JsonRpcProvider._perform` is the single funnel every read (`getTransaction
 * Count`, `estimateGas`, `getGasPrice`, `getPriorityFee`, `getBlock`, ...) goes through in ethers
 * v6 (see `ethers`' `AbstractProvider`/`JsonRpcProvider` sources) — stubbing it directly (rather
 * than the raw JSON-RPC `send`) is stable across ethers' exact wire-format choices and avoids any
 * real network access. `staticNetwork` avoids a chain-ID-detection call entirely, and
 * `cacheTimeout: -1` disables ethers' own ~250ms same-request de-duplication so each assertion
 * below reflects an actual, individual `_perform` invocation.
 */
import { JsonRpcProvider, Transaction } from 'ethers'

import { MonadAccountTxSigner, MonadTxSubmitter } from './monad-account-tx'
import { MonadTxReceipt } from './monad-http'

// A real (arbitrary, unfunded) secp256k1 private key — needed because signing is real ECDSA
// signing via ethers, not stubbed. Never used anywhere else; carries no funds on any network.
const TEST_PRIVATE_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690'
const TEST_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const CHAIN_ID = 10143 // Monad testnet's chain ID; only a realistic stand-in here.

function makeStubProvider(
  perform: (req: { method: string }) => Promise<unknown>,
) {
  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(provider as any)._perform = perform
  return provider
}

function makeMockHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(),
    getTransactionReceipt: jest.fn(),
  }
}

describe('MonadAccountTxSigner', () => {
  it('exposes the address derived from the given private key', () => {
    const provider = makeStubProvider(async () => {
      throw new Error('no chain reads expected')
    })
    const signer = new MonadAccountTxSigner({
      privateKey: TEST_PRIVATE_KEY,
      provider,
      httpClient: makeMockHttpClient(),
    })
    expect(signer.address.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())
  })

  describe('buildAndSignTransfer', () => {
    it('fetches the nonce fresh and estimates gas via the provider, signing a valid tx', async () => {
      const performCalls: Array<{ method: string }> = []
      const provider = makeStubProvider(async req => {
        performCalls.push(req)
        if (req.method === 'getTransactionCount') return '0x2a' // 42
        if (req.method === 'estimateGas') return '0x5208' // 21000
        throw new Error(`unexpected _perform: ${req.method}`)
      })
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider,
        httpClient: makeMockHttpClient(),
      })

      const value = 1_000_000_000_000_000_000n
      const signed = await signer.buildAndSignTransfer(RECIPIENT, value, {
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
      })

      expect(
        performCalls.filter(c => c.method === 'getTransactionCount'),
      ).toHaveLength(1)
      expect(performCalls.filter(c => c.method === 'estimateGas')).toHaveLength(
        1,
      )

      expect(signed.nonce).toBe(42)
      expect(signed.gasLimit).toBe(21000n)
      expect(signed.data).toBe('0x')
      expect(signed.to.toLowerCase()).toBe(RECIPIENT.toLowerCase())
      expect(signed.value).toBe(value)
      expect(signed.chainId).toBe(BigInt(CHAIN_ID))
      expect(signed.from.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())

      // Independent decode: proves the raw tx is a real, validly signed transaction, not just
      // whatever fields we happened to pass in.
      const decoded = Transaction.from(signed.rawTx)
      expect(decoded.hash).toBe(signed.txHash)
      expect(decoded.from?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())
      expect(decoded.nonce).toBe(42)
      expect(decoded.gasLimit).toBe(21000n)
      expect(decoded.value).toBe(value)
      expect(decoded.to?.toLowerCase()).toBe(RECIPIENT.toLowerCase())
    })

    it('does not re-fetch the nonce/gas when overrides are supplied for them', async () => {
      const performCalls: Array<{ method: string }> = []
      const provider = makeStubProvider(async req => {
        performCalls.push(req)
        throw new Error(`unexpected _perform: ${req.method}`)
      })
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider,
        httpClient: makeMockHttpClient(),
      })

      const signed = await signer.buildAndSignTransfer(RECIPIENT, 1n, {
        nonce: 7,
        gasLimit: 21000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000_000n,
        chainId: BigInt(CHAIN_ID),
      })

      expect(performCalls).toHaveLength(0) // fully offline: no chain reads at all
      expect(signed.nonce).toBe(7)
      expect(signed.gasLimit).toBe(21000n)
    })

    it('fetches a fresh nonce on every call — no local caching/reuse across constructions', async () => {
      let nonce = 10
      const provider = makeStubProvider(async req => {
        if (req.method === 'getTransactionCount')
          return `0x${(nonce++).toString(16)}`
        if (req.method === 'estimateGas') return '0x5208'
        throw new Error(`unexpected _perform: ${req.method}`)
      })
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider,
        httpClient: makeMockHttpClient(),
      })
      const overrides = { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }

      const first = await signer.buildAndSignTransfer(RECIPIENT, 1n, overrides)
      const second = await signer.buildAndSignTransfer(RECIPIENT, 1n, overrides)

      expect(first.nonce).toBe(10)
      expect(second.nonce).toBe(11) // different — proves no caching/reuse of the first nonce
    })
  })

  describe('buildAndSignCall', () => {
    it('builds and signs a value+calldata transaction (e.g. a future Stamp burn)', async () => {
      const provider = makeStubProvider(async req => {
        if (req.method === 'getTransactionCount') return '0x5'
        throw new Error(`unexpected _perform: ${req.method}`)
      })
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider,
        httpClient: makeMockHttpClient(),
      })

      const commitment = '0x' + 'ab'.repeat(32)
      const signed = await signer.buildAndSignCall(
        RECIPIENT,
        500n,
        commitment,
        {
          gasLimit: 30000n,
          maxFeePerGas: 3_000_000_000n,
          maxPriorityFeePerGas: 1_500_000_000n,
        },
      )

      expect(signed.data).toBe(commitment)
      expect(signed.value).toBe(500n)
      expect(signed.gasLimit).toBe(30000n)

      const decoded = Transaction.from(signed.rawTx)
      expect(decoded.data).toBe(commitment)
      expect(decoded.from?.toLowerCase()).toBe(TEST_ADDRESS.toLowerCase())
    })

    it.each(['0x', '', undefined])(
      'rejects empty calldata (%p) — use buildAndSignTransfer instead',
      async data => {
        const provider = makeStubProvider(async () => {
          throw new Error('no chain reads expected before validation')
        })
        const signer = new MonadAccountTxSigner({
          privateKey: TEST_PRIVATE_KEY,
          provider,
          httpClient: makeMockHttpClient(),
        })
        await expect(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          signer.buildAndSignCall(RECIPIENT, 0n, data as any, {
            nonce: 0,
            gasLimit: 21000n,
            maxFeePerGas: 1n,
            maxPriorityFeePerGas: 1n,
          }),
        ).rejects.toThrow(/non-empty calldata/)
      },
    )
  })

  describe('submit', () => {
    async function buildOfflineSignedTx(httpClient: MonadTxSubmitter) {
      const provider = makeStubProvider(async () => {
        throw new Error('no chain reads expected')
      })
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider,
        httpClient,
      })
      const signed = await signer.buildAndSignTransfer(RECIPIENT, 1n, {
        nonce: 0,
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
        chainId: BigInt(CHAIN_ID),
      })
      return { signer, signed }
    }

    it('submits the raw tx via the http client and returns the matching hash', async () => {
      const httpClient = makeMockHttpClient()
      const { signer, signed } = await buildOfflineSignedTx(httpClient)
      httpClient.submitRawTransaction.mockResolvedValue(signed.txHash)

      const result = await signer.submit(signed)

      expect(httpClient.submitRawTransaction).toHaveBeenCalledWith(signed.rawTx)
      expect(result).toBe(signed.txHash)
    })

    it('throws if the broadcast hash does not match the locally computed hash', async () => {
      const httpClient = makeMockHttpClient()
      const { signer, signed } = await buildOfflineSignedTx(httpClient)
      httpClient.submitRawTransaction.mockResolvedValue('0x' + 'ff'.repeat(32))

      await expect(signer.submit(signed)).rejects.toThrow(/does not match/)
    })
  })

  describe('getStatus', () => {
    function receipt(status: MonadTxReceipt['status']): MonadTxReceipt {
      return {
        txHash: '0x' + '11'.repeat(32),
        blockNumber: 1,
        blockHash: '0x' + '22'.repeat(32),
        status,
        gasUsed: 21000n,
        effectiveGasPrice: 1n,
        logs: [],
      }
    }

    it('reports "pending" when there is no receipt yet', async () => {
      const httpClient = makeMockHttpClient()
      httpClient.getTransactionReceipt.mockResolvedValue(undefined)
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider: makeStubProvider(async () => {
          throw new Error('unused')
        }),
        httpClient,
      })
      expect(await signer.getStatus('0xabc')).toBe('pending')
    })

    it('reports "confirmed" for a successful receipt', async () => {
      const httpClient = makeMockHttpClient()
      httpClient.getTransactionReceipt.mockResolvedValue(receipt('success'))
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider: makeStubProvider(async () => {
          throw new Error('unused')
        }),
        httpClient,
      })
      expect(await signer.getStatus('0xabc')).toBe('confirmed')
    })

    it('reports "failed" for a failed receipt', async () => {
      const httpClient = makeMockHttpClient()
      httpClient.getTransactionReceipt.mockResolvedValue(receipt('failure'))
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider: makeStubProvider(async () => {
          throw new Error('unused')
        }),
        httpClient,
      })
      expect(await signer.getStatus('0xabc')).toBe('failed')
    })

    it('treats an "unknown"-status receipt as confirmed (it was mined)', async () => {
      const httpClient = makeMockHttpClient()
      httpClient.getTransactionReceipt.mockResolvedValue(receipt('unknown'))
      const signer = new MonadAccountTxSigner({
        privateKey: TEST_PRIVATE_KEY,
        provider: makeStubProvider(async () => {
          throw new Error('unused')
        }),
        httpClient,
      })
      expect(await signer.getStatus('0xabc')).toBe('confirmed')
    })
  })
})
