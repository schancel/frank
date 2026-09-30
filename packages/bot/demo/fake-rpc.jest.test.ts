import { Transaction, Wallet } from 'ethers'

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
