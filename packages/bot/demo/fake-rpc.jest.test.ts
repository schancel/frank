import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { networkInterfaces, tmpdir } from 'os'
import { join } from 'path'

import { JsonRpcProvider, Transaction, Wallet } from 'ethers'

import chainRegistry from '../../../docs/protocol/chains/v1.json'
import { FakeRpc, startFakeRpc } from './fake-rpc'

async function rpc(fake: FakeRpc, method: string, params: unknown[] = []) {
  const res = await fetch(fake.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  return (await res.json()) as { result?: any; error?: { code: number; message: string } }
}

describe('fake chain RPC', () => {
  const rich = Wallet.createRandom()
  const poor = Wallet.createRandom()
  let fake: FakeRpc
  beforeEach(async () => {
    fake = await startFakeRpc({ port: 0, funded: [rich.address] })
  })
  afterEach(() => fake.close())

  async function transfer(from: Wallet, to: string, value: bigint, nonce: number) {
    const raw = await from.signTransaction({
      type: 2,
      chainId: 10143,
      nonce,
      to,
      value,
      gasLimit: 21000,
      maxFeePerGas: 50n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
    })
    return { raw, hash: Transaction.from(raw).hash as string }
  }

  it('reports Monad testnet and only funded addresses start with a balance', async () => {
    expect((await rpc(fake, 'eth_chainId')).result).toBe('0x279f')
    expect(
      BigInt((await rpc(fake, 'eth_getBalance', [rich.address])).result),
    ).toBeGreaterThanOrEqual(10n ** 24n)
    expect((await rpc(fake, 'eth_getBalance', [poor.address])).result).toBe('0x0')
  })

  it('serves the protocol-pinned genesis while keeping later demo blocks synthetic', async () => {
    const checkpoint = chainRegistry.chains
      .find(chain => chain.id === 'monad-testnet')!
      .identity_probes.find(probe => probe.kind === 'block-hash' && probe.height === 0)!
    expect(checkpoint.expected).toMatch(/^0x[0-9a-f]{64}$/)
    for (const tag of ['0x0', 'earliest']) {
      expect((await rpc(fake, 'eth_getBlockByNumber', [tag, false])).result).toMatchObject({
        number: '0x0',
        hash: checkpoint.expected,
      })
    }
    for (const tag of ['0x1', '0x3e8', 'latest']) {
      expect((await rpc(fake, 'eth_getBlockByNumber', [tag, false])).result.hash).toBe(
        `0x${'11'.repeat(32)}`,
      )
    }
  })

  // The wallet only records a native transfer as included when the node returns the very
  // transaction it signed (same signature and fee fields), in the receipt's block.
  it('returns a mined transaction exactly as it was signed, in the block its receipt names', async () => {
    const provider = new JsonRpcProvider(fake.url, 10143, { staticNetwork: true })
    try {
      const legacy = await rich.signTransaction({
        type: 0,
        chainId: 10143,
        nonce: 1,
        to: poor.address,
        value: 7n,
        gasLimit: 21000,
        gasPrice: 50n * 10n ** 9n,
      })
      for (const raw of [(await transfer(rich, poor.address, 5n, 0)).raw, legacy]) {
        const hash = Transaction.from(raw).hash as string
        expect((await rpc(fake, 'eth_sendRawTransaction', [raw])).result).toBe(hash)
        const [found, receipt] = await Promise.all([
          provider.getTransaction(hash),
          provider.getTransactionReceipt(hash),
        ])
        expect(Transaction.from(found!).serialized).toBe(raw)
        expect(found!.from).toBe(rich.address)
        expect(found!.blockHash).toBe(receipt!.blockHash)
        expect(found!.blockNumber).toBe(receipt!.blockNumber)
        expect(found!.index).toBe(receipt!.index)
        const latest = await provider.getBlock('latest')
        expect(receipt!.blockNumber).toBeLessThanOrEqual(latest!.number)
        expect((await provider.getBlock(receipt!.blockNumber))!.hash).toBe(receipt!.blockHash)
      }
    } finally {
      provider.destroy()
    }
  })

  it('a transfer moves value, is mined at once, and bumps the sender nonce', async () => {
    const { raw, hash } = await transfer(rich, poor.address, 5n * 10n ** 16n, 0)
    expect((await rpc(fake, 'eth_sendRawTransaction', [raw])).result).toBe(hash)
    expect(BigInt((await rpc(fake, 'eth_getBalance', [poor.address])).result)).toBe(5n * 10n ** 16n)
    expect((await rpc(fake, 'eth_getTransactionCount', [rich.address, 'pending'])).result).toBe(
      '0x1',
    )
    expect((await rpc(fake, 'eth_getTransactionReceipt', [hash])).result.status).toBe('0x1')
    expect((await rpc(fake, 'eth_getTransactionByHash', [hash])).result.blockNumber).not.toBeNull()
    expect(fake.transactions()).toEqual([
      { hash, from: rich.address, to: poor.address, valueWei: (5n * 10n ** 16n).toString() },
    ])
  })

  it('replaying the same raw transaction moves nothing twice', async () => {
    const { raw } = await transfer(rich, poor.address, 10n ** 16n, 0)
    await rpc(fake, 'eth_sendRawTransaction', [raw])
    await rpc(fake, 'eth_sendRawTransaction', [raw])
    expect(BigInt((await rpc(fake, 'eth_getBalance', [poor.address])).result)).toBe(10n ** 16n)
    expect(fake.transactions()).toHaveLength(1)
  })

  it('an unknown transaction has no receipt, and an unknown method is a JSON-RPC error', async () => {
    expect(
      (await rpc(fake, 'eth_getTransactionReceipt', [`0x${'ab'.repeat(32)}`])).result,
    ).toBeNull()
    expect((await rpc(fake, 'eth_call')).error?.code).toBe(-32601)
  })

  it('the balance never goes negative', async () => {
    const { raw } = await transfer(poor, rich.address, 10n ** 18n, 0)
    await rpc(fake, 'eth_sendRawTransaction', [raw])
    expect((await rpc(fake, 'eth_getBalance', [poor.address])).result).toBe('0x0')
  })
})

describe('fake chain CORS (#361)', () => {
  let fake: FakeRpc
  beforeEach(async () => {
    fake = await startFakeRpc({ port: 0 })
  })
  afterEach(() => fake.close())

  it('answers a browser preflight with 204 and the CORS headers', async () => {
    const res = await fetch(fake.url, {
      method: 'OPTIONS',
      headers: {
        'origin': 'http://localhost:8080',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-methods')).toMatch(/POST/)
    expect(res.headers.get('access-control-allow-headers')).toMatch(/content-type/)
    expect(await res.text()).toBe('')
  })

  it('adds the header to every response: a JSON-RPC POST, a parse error and /_ctl', async () => {
    const post = await fetch(fake.url, {
      method: 'POST',
      headers: { 'origin': 'http://localhost:8080', 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    })
    expect(post.headers.get('access-control-allow-origin')).toBe('*')
    expect((await post.json()).result).toBe('0x279f')
    const bad = await fetch(fake.url, { method: 'POST', body: 'not json' })
    expect(bad.headers.get('access-control-allow-origin')).toBe('*')
    const ctl = await fetch(`${fake.url}/_ctl`)
    expect(ctl.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('does not echo arbitrary requested headers (only header-name characters)', async () => {
    const res = await fetch(fake.url, {
      method: 'OPTIONS',
      headers: { 'access-control-request-headers': 'x-ok, content-type' },
    })
    expect(res.headers.get('access-control-allow-headers')).toBe('x-ok, content-type')
  })
})

describe('fake chain persistence', () => {
  const rich = Wallet.createRandom()
  const poor = Wallet.createRandom()
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-ledger-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function call(fake: FakeRpc, method: string, params: unknown[] = []) {
    const res = await fetch(fake.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    return (await res.json()) as { result?: any }
  }

  it('a restarted chain keeps balances, nonces and transactions', async () => {
    const stateFile = join(dir, 'fake-chain', 'ledger.json')
    const first = await startFakeRpc({ port: 0, funded: [rich.address], stateFile })
    const raw = await rich.signTransaction({
      type: 2,
      chainId: 10143,
      nonce: 0,
      to: poor.address,
      value: 7n * 10n ** 17n,
      gasLimit: 21000,
      maxFeePerGas: 50n * 10n ** 9n,
      maxPriorityFeePerGas: 10n ** 9n,
    })
    const hash = Transaction.from(raw).hash as string
    await call(first, 'eth_sendRawTransaction', [raw])
    const richBalance = (await call(first, 'eth_getBalance', [rich.address])).result
    await first.close()
    expect(statSync(stateFile).mode & 0o077).toBe(0)

    const second = await startFakeRpc({ port: 0, funded: [rich.address], stateFile })
    try {
      expect(second.restoredTransactions).toBe(1)
      expect(BigInt((await call(second, 'eth_getBalance', [poor.address])).result)).toBe(
        7n * 10n ** 17n,
      )
      // The funded address is NOT refilled on restart: it keeps what it had after spending.
      expect((await call(second, 'eth_getBalance', [rich.address])).result).toBe(richBalance)
      expect((await call(second, 'eth_getTransactionCount', [rich.address])).result).toBe('0x1')
      expect((await call(second, 'eth_getTransactionReceipt', [hash])).result.status).toBe('0x1')
    } finally {
      await second.close()
    }
  })

  it('refuses a corrupt ledger instead of silently starting an empty chain', async () => {
    const stateFile = join(dir, 'ledger.json')
    writeFileSync(stateFile, '{ not json')
    await expect(startFakeRpc({ port: 0, stateFile })).rejects.toThrow(/cannot be read/)
    expect(readFileSync(stateFile, 'utf8')).toBe('{ not json')
  })
})

describe('fake chain bind address', () => {
  it('listens on 127.0.0.1 only by default, so nothing off this machine can reach it', async () => {
    const fake = await startFakeRpc({ port: 0 })
    try {
      expect(fake.host).toBe('127.0.0.1')
      expect(fake.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
      // Where the machine has a non-loopback address, the fake chain must refuse connections there.
      const external = Object.values(networkInterfaces())
        .flat()
        .find(i => i && i.family === 'IPv4' && !i.internal)
      if (external) {
        await expect(fetch(`http://${external.address}:${fake.port}/`)).rejects.toThrow()
      }
    } finally {
      await fake.close()
    }
  })
})
