/**
 * Unit tests for `monad-pop-client.ts` (ticket #5), against:
 *   - a real `MonadSubAccountPool` (#14)/`SubAccountLeaseManager` (#18) pair, backed by an
 *     in-memory store -- exercises the actual lease-acquire/release state machine rather than
 *     mocking it away;
 *   - a stubbed ethers `Provider` (`_perform`, same technique as `monad-account-tx.jest.test.ts`)
 *     so `MonadAccountTxSigner.buildAndSignTransfer` (#11) does real, valid local signing with no
 *     network access;
 *   - a mocked `MonadTxSubmitter` (`monadHttpClient`) standing in for `MonadHttpClient`'s
 *     submit/receipt surface;
 *   - a mocked `PopHttpClient` standing in for the actual HTTP calls to the registry's
 *     `PUT /metadata/:addr` (no real `axios`/network involved) -- lets these tests assert exactly
 *     which query params/headers `MonadPopClient` sends on each round trip, and script the
 *     402-then-200 sequence `pop_protection.rs` produces.
 *
 * This is a real, running jest suite (ticket #28 installed the actual jest toolchain) -- run via
 * `yarn test:unit:ci` from `app/`.
 */
import { JsonRpcProvider, Transaction } from 'ethers'

import { MonadHdKeyring } from './monad-hd-keyring'
import { MonadSubAccountPool } from './monad-account-pool'
import { SubAccountLeaseManager } from './monad-account-lease'
import { MonadTxSubmitter } from './monad-account-tx'
import { MonadTxReceipt } from './monad-http'
import {
  MonadPopClient,
  PopHttpClient,
  PopHttpResponse,
  PopPaymentNotConfirmedError,
  PopProtocolError,
  PopUnexpectedResponseError,
  POP_TX_HASH_PARAM,
} from './monad-pop-client'

const TEST_MNEMONIC =
  'test test test test test test test test test test test junk'
const CHAIN_ID = 10143 // Monad testnet's chain ID; only a realistic stand-in here.
const RECIPIENT = '0x000000000000000000000000000000000000dEaD'
const REGISTRY_BASE_URL = 'https://registry.example.invalid'
const ADDRESS = 'lotus_some_test_address'

function makePool(size: number): MonadSubAccountPool {
  const keyring = MonadHdKeyring.fromMnemonic(TEST_MNEMONIC)
  const pool = new MonadSubAccountPool({ keyring })
  pool.ensureSize(size)
  return pool
}

/** Stub `Provider`: answers `getTransactionCount`/`estimateGas` (everything
 * `buildAndSignTransfer` needs) with fixed values, exactly like
 * `monad-account-tx.jest.test.ts`'s own helper. */
function makeStubProvider(): JsonRpcProvider {
  const provider = new JsonRpcProvider('http://127.0.0.1:1', CHAIN_ID, {
    staticNetwork: true,
    cacheTimeout: -1,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(provider as any)._perform = async (req: { method: string }) => {
    if (req.method === 'getTransactionCount') return '0x0'
    if (req.method === 'estimateGas') return '0x5208' // 21000
    // Fee estimation (`ethers`' `getFeeData`, invoked by `Wallet.populateTransaction` for any
    // field not explicitly overridden -- this module never overrides fee fields, so all of these
    // are hit). No `baseFeePerGas` on the block keeps this on the legacy (pre-EIP-1559) fee path,
    // avoiding the need to stub EIP-1559-specific fields too.
    if (req.method === 'getBlock') {
      return {
        hash: '0x' + '11'.repeat(32),
        parentHash: '0x' + '00'.repeat(32),
        number: '0x1',
        timestamp: '0x1',
        nonce: '0x0000000000000000',
        difficulty: '0x0',
        gasLimit: '0x5208',
        gasUsed: '0x0',
        miner: '0x' + '00'.repeat(20),
        extraData: '0x',
        transactions: [],
      }
    }
    if (req.method === 'getGasPrice') return '0x3b9aca00' // 1 gwei
    if (req.method === 'getPriorityFee') {
      throw new Error('legacy chain: no eip-1559 priority fee') // caught internally by ethers
    }
    throw new Error(`unexpected _perform: ${req.method}`)
  }
  return provider
}

/** Mock `MonadTxSubmitter`: `submitRawTransaction` recomputes the real signed hash (so
 * `MonadAccountTxSigner.submit`'s own broadcast-hash-matches-signed-hash check passes) instead of
 * hardcoding one; `getTransactionReceipt` is scripted per test. */
function makeMonadHttpClient(): jest.Mocked<MonadTxSubmitter> {
  return {
    submitRawTransaction: jest.fn(async (rawTxHex: string) => {
      const parsed = Transaction.from(rawTxHex)
      if (parsed.hash === null) throw new Error('unexpectedly unhashed tx')
      return parsed.hash
    }),
    getTransactionReceipt: jest.fn(),
  }
}

function confirmedReceipt(txHash: string): MonadTxReceipt {
  return {
    txHash,
    blockNumber: 1,
    blockHash: '0x' + 'aa'.repeat(32),
    status: 'success',
    gasUsed: 21000n,
    effectiveGasPrice: 1n,
    logs: [],
  }
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): PopHttpResponse {
  return { status, headers, data: body }
}

function challengeBody(recipient: string, minValueWei: string) {
  return {
    error: 'payment_required',
    reason: 'no_token_or_proof',
    detail: null,
    recipient,
    min_value_wei: minValueWei,
    how_to_pay: 'pay up',
  }
}

function makeFakeClock(stepMs: number) {
  let elapsed = 0
  return {
    now: () => elapsed,
    sleep: async (ms: number) => {
      elapsed += ms > 0 ? ms : stepMs
    },
  }
}

describe('MonadPopClient.payAndPutMetadata', () => {
  it('pays over Monad from a leased sub-account, redeems the proof, and caches the returned token', async () => {
    const pool = makePool(2)
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const monadHttpClient = makeMonadHttpClient()
    const popHttpClient: jest.Mocked<PopHttpClient> = {
      putRegistryMetadata: jest.fn(),
    }

    const minValueWei = '1000'
    popHttpClient.putRegistryMetadata
      // 1st attempt: no token yet -> 402 challenge naming recipient/min_value_wei.
      .mockResolvedValueOnce(
        jsonResponse(402, challengeBody(RECIPIENT, minValueWei)),
      )
      // 2nd attempt: after the payment confirms, redeem with pop_tx_hash -> success + fresh token.
      .mockResolvedValueOnce(
        jsonResponse(200, {}, { 'x-pop-token': 'POP freshly-minted-token' }),
      )

    monadHttpClient.getTransactionReceipt.mockImplementation(async hash =>
      confirmedReceipt(hash),
    )

    const client = new MonadPopClient({
      leaseManager,
      pool,
      provider,
      monadHttpClient,
      registryBaseUrl: REGISTRY_BASE_URL,
      popHttpClient,
    })

    const body = new Uint8Array([1, 2, 3])
    const result = await client.payAndPutMetadata({ address: ADDRESS, body })

    expect(result.reusedToken).toBe(false)
    expect(result.token).toBe('freshly-minted-token')
    expect(result.payment).toBeDefined()
    expect(result.payment?.recipient.toLowerCase()).toBe(
      RECIPIENT.toLowerCase(),
    )
    expect(result.payment?.minValueWei).toBe(1000n)

    // First (probing) call carried no auth at all.
    const firstCall = popHttpClient.putRegistryMetadata.mock.calls[0][0]
    expect(firstCall.headers).toBeUndefined()
    expect(firstCall.query).toBeUndefined()
    expect(firstCall.address).toBe(ADDRESS)
    expect(firstCall.body).toBe(body)

    // Second (redeeming) call carried exactly the confirmed tx hash as pop_tx_hash.
    const secondCall = popHttpClient.putRegistryMetadata.mock.calls[1][0]
    expect(secondCall.query).toEqual({
      [POP_TX_HASH_PARAM]: result.payment?.txHash,
    })

    // The payment tx was actually built for the challenge's recipient/amount.
    expect(monadHttpClient.submitRawTransaction).toHaveBeenCalledTimes(1)

    // Lease lifecycle: acquired then released as 'spent' on confirmation (ticket #34: every
    // `SubAccountLeaseManager` caller, POP included, now gets the corrected "never reuse a used
    // sub-account" behavior -- see `monad-account-lease.ts`. `PLAN.md` constraint 3 notes POP's
    // account-opening payment would be a legitimate exception to the *privacy* rationale for
    // single-use accounts, since it's already identity-bound to a specific server -- but POP has no
    // separate reuse mechanism of its own; it shares the same lease manager/pool as Stamp, and POP
    // is disabled entirely for the hackathon demo anyway, so this doesn't matter in practice yet).
    expect(client.getCachedToken(ADDRESS)).toBe('freshly-minted-token')
    expect(result.payment).toBeDefined()
    const record = pool.getRecord(result.payment?.leaseIndex as number)
    expect(record?.status).toBe('spent')
  })

  it('reuses a cached token on a later call instead of paying again', async () => {
    const pool = makePool(1)
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const monadHttpClient = makeMonadHttpClient()
    monadHttpClient.getTransactionReceipt.mockImplementation(async hash =>
      confirmedReceipt(hash),
    )
    const popHttpClient: jest.Mocked<PopHttpClient> = {
      putRegistryMetadata: jest.fn(),
    }
    popHttpClient.putRegistryMetadata
      .mockResolvedValueOnce(jsonResponse(402, challengeBody(RECIPIENT, '1')))
      .mockResolvedValueOnce(
        jsonResponse(200, {}, { 'x-pop-token': 'POP token-one' }),
      )

    const client = new MonadPopClient({
      leaseManager,
      pool,
      provider,
      monadHttpClient,
      registryBaseUrl: REGISTRY_BASE_URL,
      popHttpClient,
    })

    const first = await client.payAndPutMetadata({
      address: ADDRESS,
      body: new Uint8Array(),
    })
    expect(first.reusedToken).toBe(false)

    // Third call: presenting the cached token succeeds outright -- no new challenge, no new tx.
    popHttpClient.putRegistryMetadata.mockResolvedValueOnce(
      jsonResponse(200, {}),
    )
    const second = await client.payAndPutMetadata({
      address: ADDRESS,
      body: new Uint8Array(),
    })

    expect(second.reusedToken).toBe(true)
    expect(second.token).toBe('token-one')
    expect(monadHttpClient.submitRawTransaction).toHaveBeenCalledTimes(1) // still just the one payment
    const thirdCallReq = popHttpClient.putRegistryMetadata.mock.calls[2][0]
    expect(thirdCallReq.headers).toEqual({ Authorization: 'POP token-one' })
  })

  it('retires the leased sub-account and throws when the payment never confirms', async () => {
    const pool = makePool(1)
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const monadHttpClient = makeMonadHttpClient()
    monadHttpClient.getTransactionReceipt.mockResolvedValue(undefined) // stays pending forever
    const popHttpClient: jest.Mocked<PopHttpClient> = {
      putRegistryMetadata: jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(402, challengeBody(RECIPIENT, '1')),
        ),
    }

    const client = new MonadPopClient({
      leaseManager,
      pool,
      provider,
      monadHttpClient,
      registryBaseUrl: REGISTRY_BASE_URL,
      popHttpClient,
    })

    const clock = makeFakeClock(1000)
    await expect(
      client.payAndPutMetadata({
        address: ADDRESS,
        body: new Uint8Array(),
        settlement: {
          pollIntervalMs: 1000,
          timeoutMs: 2000,
          sleep: clock.sleep,
          now: clock.now,
        },
      }),
    ).rejects.toBeInstanceOf(PopPaymentNotConfirmedError)

    // Documented abandonment on failure: the sub-account is retired, not left 'in-use' forever,
    // and no token was cached.
    const record = pool.getRecord(0)
    expect(record?.status).toBe('retired')
    expect(client.getCachedToken(ADDRESS)).toBeUndefined()
  })

  it('throws PopProtocolError when the 402 challenge is missing recipient/min_value_wei', async () => {
    const pool = makePool(1)
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const monadHttpClient = makeMonadHttpClient()
    const popHttpClient: jest.Mocked<PopHttpClient> = {
      putRegistryMetadata: jest
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(402, { error: 'payment_required' }),
        ),
    }

    const client = new MonadPopClient({
      leaseManager,
      pool,
      provider,
      monadHttpClient,
      registryBaseUrl: REGISTRY_BASE_URL,
      popHttpClient,
    })

    await expect(
      client.payAndPutMetadata({ address: ADDRESS, body: new Uint8Array() }),
    ).rejects.toBeInstanceOf(PopProtocolError)

    // No lease should have been touched -- the failure happened before acquiring one.
    expect(pool.getRecord(0)?.status).toBe('available')
    expect(monadHttpClient.submitRawTransaction).not.toHaveBeenCalled()
  })

  it('throws PopUnexpectedResponseError on a non-200/402 response', async () => {
    const pool = makePool(1)
    const leaseManager = new SubAccountLeaseManager(pool)
    const provider = makeStubProvider()
    const monadHttpClient = makeMonadHttpClient()
    const popHttpClient: jest.Mocked<PopHttpClient> = {
      putRegistryMetadata: jest
        .fn()
        .mockResolvedValueOnce(jsonResponse(500, { error: 'boom' })),
    }

    const client = new MonadPopClient({
      leaseManager,
      pool,
      provider,
      monadHttpClient,
      registryBaseUrl: REGISTRY_BASE_URL,
      popHttpClient,
    })

    await expect(
      client.payAndPutMetadata({ address: ADDRESS, body: new Uint8Array() }),
    ).rejects.toBeInstanceOf(PopUnexpectedResponseError)
  })
})
