import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { createServer, Server } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider } from 'ethers'

import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import { createEvmChain } from "../../wallet/chain/monad-chain";
import type { EvmChainWalletHandle } from "../../wallet/evm-wallet-handle";
import type { MonadRootBundle } from '../../wallet/chain/active-chain'
import { InMemoryNativeTransactionAttemptStore } from '../../wallet/chain/chain-wallet'
import * as providerModule from '../../wallet/monad-provider'
import { FakeRpc, startFakeRpc } from './fake-rpc'
import {
  DEMO_FUNDING_AMOUNT_WEI,
  DEMO_FUNDING_KIND,
  DEMO_FUNDING_PATH,
  ensureDemoBalance,
} from './demo-funding'
import { fundDemo } from './fund-demo'

const RECEIVE = '0x4669EFf913A3c595CeA5FA92a600201e8e9E75d8'
const AUTH = '0xa3b72b83A95d61352E969D9f09DB4276295B4175'
const RECIPIENT = '0x0000000000000000000000000000000000001234'
const AMOUNT = BigInt(DEMO_FUNDING_AMOUNT_WEI)

function roots(): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: Uint8Array.from(
      Buffer.from(vectors.vectors[0].outputs[purpose], 'hex'),
    ),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}

describe('explicit simulated funding boundary', () => {
  let dir: string
  let stateFile: string
  let fake: FakeRpc
  const mode = () => ({ fakeChain: true, rpcUrl: fake.url })
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'demo-funding-'))
    stateFile = join(dir, 'ledger.json')
    fake = await startFakeRpc({ port: 0, stateFile, demoFunding: true })
  })
  afterEach(async () => {
    jest.restoreAllMocks()
    await fake.close()
    rmSync(dir, { recursive: true, force: true })
  })
  async function balance(address: string): Promise<bigint> {
    const response = await fetch(fake.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getBalance',
        params: [address, 'latest'],
      }),
    })
    return BigInt((await response.json()).result)
  }
  async function request(input: unknown, token?: string) {
    return fetch(`${fake.url}${DEMO_FUNDING_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-frank-demo-funding': token ?? '',
      },
      body: JSON.stringify(input),
    })
  }
  async function capability() {
    return (await fetch(`${fake.url}${DEMO_FUNDING_PATH}`)).json()
  }

  it('funds and spends through the actual typed wallet, preserves auth and spent balances on restart, and explicitly tops up', async () => {
    // Only transport selection is replaced: real typed derivation, balances, native signer and
    // submitter execute against a disposable HTTP fake service, never a relay or real network.
    const providers: JsonRpcProvider[] = []
    jest
      .spyOn(providerModule, 'createMonadJsonRpcProvider')
      .mockImplementation(() => {
        const provider = new JsonRpcProvider(fake.url, 10143, {
          staticNetwork: true,
          cacheTimeout: -1,
        })
        providers.push(provider)
        return provider
      })
    const chain = createEvmChain({
      networkId: 'monad-test',
      chainId: 10143,
      rpcChain: 'monad-testnet',
      relayBaseUrl: fake.url,
      networkTag: 'MONT',
      stampBurnAddress: RECIPIENT,
      defaultStampValueWei: 1n,
      defaultTopicVoteValueWei: 1n,
      subAccountPoolSize: 1,
      walletStorageLocation: false,
      nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
    })
    const wallet = (await chain.createWallet(roots())) as EvmChainWalletHandle
    try {
      const address = (await wallet.getReceiveAddress()).raw
      expect(address).toBe(RECEIVE)
      expect(wallet.identity.address.raw).toBe(AUTH)
      expect(address).not.toBe(AUTH)
      expect(await chain.nativeTransfers.getBalance({ wallet })).toBe(0n)
      const fetchCalls = jest.spyOn(globalThis, 'fetch')
      const credited = await ensureDemoBalance(mode(), address)
      expect(credited).toEqual({
        kind: DEMO_FUNDING_KIND,
        evmReceiveAddress: address.toLowerCase(),
        balanceWei: AMOUNT.toString(),
        creditedWei: AMOUNT.toString(),
      })
      const fundingCall = fetchCalls.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith(DEMO_FUNDING_PATH) && init?.method === 'POST',
      )!
      expect(JSON.parse(fundingCall[1]!.body as string)).toEqual({
        evmReceiveAddress: address,
        amountWei: AMOUNT.toString(),
      })
      fetchCalls.mockRestore()
      expect(await balance(AUTH)).toBe(0n)
      expect(wallet.identity.address.raw).toBe(AUTH)
      expect(await chain.nativeTransfers.getBalance({ wallet })).toBe(AMOUNT)
      expect((await ensureDemoBalance(mode(), address)).creditedWei).toBe('0')
      expect(fake.transactions()).toEqual([]) // Credit has no signature or chain transaction.
      const sent = await chain.nativeTransfers.send({
        wallet,
        recipient: { raw: RECIPIENT },
        value: AMOUNT / 4n,
      })
      expect(fake.transactions()).toEqual([
        expect.objectContaining({
          hash: sent.txHash,
          from: RECEIVE,
          to: RECIPIENT,
        }),
      ])
      expect(await balance(RECIPIENT)).toBe(AMOUNT / 4n)
      const spentBalance = await chain.nativeTransfers.getBalance({ wallet })
      expect(spentBalance).toBeGreaterThan(0n)
      expect(spentBalance).toBeLessThan((AMOUNT * 3n) / 4n)
      const port = fake.port
      await fake.close()
      fake = await startFakeRpc({ port, stateFile, demoFunding: true })
      expect(await chain.nativeTransfers.getBalance({ wallet })).toBe(
        spentBalance,
      )
      expect(await balance(AUTH)).toBe(0n)
      const topUp = await ensureDemoBalance(mode(), address)
      expect(topUp.creditedWei).toBe((AMOUNT - spentBalance).toString())
      expect((await ensureDemoBalance(mode(), address)).creditedWei).toBe('0')
      expect(
        JSON.parse(readFileSync(stateFile, 'utf8')).balances[
          address.toLowerCase()
        ],
      ).toBe(AMOUNT.toString())
    } finally {
      await wallet.close()
      for (const provider of providers) provider.destroy()
    }
  })

  it('retries concurrently without accumulating credit, and keeps balances above the floor', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureDemoBalance(mode(), RECEIVE)),
    )
    expect(
      results.reduce((sum, result) => sum + BigInt(result.creditedWei), 0n),
    ).toBe(AMOUNT)
    await fake.close()
    fake = await startFakeRpc({
      port: 0,
      stateFile,
      demoFunding: true,
      funded: [RECIPIENT],
    })
    const richBalance = await balance(RECIPIENT)
    expect(richBalance).toBeGreaterThan(AMOUNT)
    expect((await ensureDemoBalance(mode(), RECIPIENT)).balanceWei).toBe(
      richBalance.toString(),
    )
    expect(await balance(RECEIVE)).toBe(AMOUNT)
  })

  it.each([undefined, '', '0x1234', AUTH + '00'])(
    'rejects an invalid receive address before transport: %s',
    async address => {
      const transport = jest.spyOn(globalThis, 'fetch')
      await expect(
        ensureDemoBalance(mode(), address as string),
      ).rejects.toThrow('EVM receive address')
      expect(transport).not.toHaveBeenCalled()
    },
  )

  it.each([
    'http://example.invalid:8545',
    'http://localhost:8545',
    'https://127.0.0.1:8545',
    'http://127.0.0.1:8545/path',
    'http://user@127.0.0.1:8545',
    'http://127.0.0.1:8545?target=remote',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
  ])('rejects arbitrary targets without transport: %s', async rpcUrl => {
    const transport = jest.spyOn(globalThis, 'fetch')
    await expect(
      ensureDemoBalance({ fakeChain: true, rpcUrl }, RECEIVE),
    ).rejects.toThrow('loopback')
    expect(transport).not.toHaveBeenCalled()
  })

  it('rejects real-mode invocation before transport and CLI invocations without explicit fake mode', async () => {
    const transport = jest.spyOn(globalThis, 'fetch')
    await expect(
      ensureDemoBalance({ ...mode(), fakeChain: false }, RECEIVE),
    ).rejects.toThrow('fake-chain mode')
    await expect(
      fundDemo(['--port', String(fake.port), RECEIVE]),
    ).rejects.toThrow('Usage:')
    expect(transport).not.toHaveBeenCalled()
  })

  it('does not expose credit without explicit persisted loopback capability', async () => {
    await expect(startFakeRpc({ port: 0, demoFunding: true })).rejects.toThrow(
      'persisted',
    )
    await expect(
      startFakeRpc({ port: 0, host: '0.0.0.0', stateFile, demoFunding: true }),
    ).rejects.toThrow('loopback')
    await fake.close()
    fake = await startFakeRpc({ port: 0, stateFile })
    await expect(ensureDemoBalance(mode(), RECEIVE)).rejects.toThrow(
      'capability unavailable',
    )
    expect(
      (
        await request({
          evmReceiveAddress: RECEIVE,
          amountWei: AMOUNT.toString(),
        })
      ).status,
    ).toBe(404)
    expect(await balance(RECEIVE)).toBe(0n)
  })

  it.each([
    '0',
    '-1',
    '1000000000000000001',
    '1e18',
    1000000000000000000,
    null,
  ])('rejects invalid wire amounts: %s', async amountWei => {
    const { token } = await capability()
    expect(
      (await request({ evmReceiveAddress: RECEIVE, amountWei }, token)).status,
    ).toBe(400)
    expect(await balance(RECEIVE)).toBe(0n)
  })

  it('rejects missing/stale capability, invalid addresses and extra fields at the control boundary', async () => {
    const input = { evmReceiveAddress: RECEIVE, amountWei: AMOUNT.toString() }
    const { token } = await capability()
    expect((await request(input)).status).toBe(403)
    expect(
      (await request({ ...input, evmReceiveAddress: 'not an address' }, token))
        .status,
    ).toBe(400)
    expect(
      (await request({ ...input, privateKey: 'forbidden' }, token)).status,
    ).toBe(400)
    expect(
      (await request({ ...input, padding: 'x'.repeat(1024) }, token)).status,
    ).toBe(413)
    await fake.close()
    fake = await startFakeRpc({ port: 0, stateFile, demoFunding: true })
    expect((await request(input, token)).status).toBe(403)
    expect(await balance(RECEIVE)).toBe(0n)
  })

  it('rolls back failed ledger writes, retries durably, and never acknowledges a failed no-op write', async () => {
    mkdirSync(`${stateFile}.tmp`)
    await expect(ensureDemoBalance(mode(), RECEIVE)).rejects.toThrow(
      'credit failed',
    )
    expect(await balance(RECEIVE)).toBe(0n)
    rmSync(`${stateFile}.tmp`, { recursive: true })
    expect((await ensureDemoBalance(mode(), RECEIVE)).creditedWei).toBe(
      AMOUNT.toString(),
    )
    mkdirSync(`${stateFile}.tmp`)
    await expect(ensureDemoBalance(mode(), RECEIVE)).rejects.toThrow(
      'credit failed',
    )
    expect(await balance(RECEIVE)).toBe(AMOUNT)
    rmSync(`${stateFile}.tmp`, { recursive: true })
    await fake.close()
    fake = await startFakeRpc({ port: 0, stateFile, demoFunding: true })
    expect(await balance(RECEIVE)).toBe(AMOUNT)
    expect((await ensureDemoBalance(mode(), RECEIVE)).creditedWei).toBe('0')
  })

  it('the operator seam prints only simulated public balance results', async () => {
    const output = jest.spyOn(console, 'log').mockImplementation(() => {})
    await fundDemo(['--fake-chain', '--port', String(fake.port), RECEIVE])
    expect(output).toHaveBeenCalledWith(
      `Simulated ledger credit only: ${JSON.stringify({
        kind: DEMO_FUNDING_KIND,
        evmReceiveAddress: RECEIVE.toLowerCase(),
        balanceWei: AMOUNT.toString(),
        creditedWei: AMOUNT.toString(),
      })}`,
    )
  })
})

describe('capability detection never substitutes chain identity or follows redirects', () => {
  let server: Server
  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  it.each(['identity', 'redirect'])(
    'refuses %s without a funding POST',
    async kind => {
      const requests: string[] = []
      server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`)
        if (kind === 'redirect') {
          res.writeHead(302, { location: '/redirected' })
          res.end()
        } else {
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              chainId: 10143,
              genesis:
                '0x298034669ee44327d2da9744b9b2782848e2f2a6959756b7b0471b09a404f5c9',
            }),
          )
        }
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port
      await expect(
        ensureDemoBalance(
          { fakeChain: true, rpcUrl: `http://127.0.0.1:${port}` },
          RECEIVE,
        ),
      ).rejects.toThrow()
      expect(requests).toEqual([`GET ${DEMO_FUNDING_PATH}`])
    },
  )
})
