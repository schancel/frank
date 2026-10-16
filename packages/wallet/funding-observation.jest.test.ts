import { JsonRpcProvider, Transaction, Wallet } from 'ethers'
import { MonadAccountTxSigner, MonadTxSubmitter } from './evm-account-tx'
import { MonadTxReceipt } from './evm-http'

// Public offline fixture keys, never used for network activity.
const key = '0x' + '11'.repeat(32)
const recipient = new Wallet('0x' + '22'.repeat(32)).address
const blockHash = '0x' + 'ab'.repeat(32)
const otherHash = '0x' + 'cd'.repeat(32)

async function fixture(overrides = {}) {
  const rawTx = await new Wallet(key).signTransaction({
    to: recipient, value: 12n, chainId: 1n, nonce: 3, gasLimit: 21000n,
    gasPrice: 1n, ...overrides,
  })
  const txHash = Transaction.from(rawTx).hash!
  const receipt: MonadTxReceipt = {
    txHash, blockNumber: 10, blockHash, status: 'success', gasUsed: 21000n,
    effectiveGasPrice: 1n, logs: [],
  }
  const provider = new JsonRpcProvider('http://127.0.0.1:1', 1, {
    staticNetwork: true, cacheTimeout: -1,
  })
  const getBlock = jest.spyOn(provider, 'getBlock').mockResolvedValue({
    number: 10, hash: blockHash,
  } as Awaited<ReturnType<typeof provider.getBlock>>)
  const getTransactionCount = jest.spyOn(provider, 'getTransactionCount')
    .mockImplementation(async address => address === recipient ? 0 : 4)
  const getBalance = jest.spyOn(provider, 'getBalance').mockResolvedValue(12n)
  const http: jest.Mocked<MonadTxSubmitter> = {
    getTransactionReceipt: jest.fn().mockResolvedValue(receipt),
    submitRawTransaction: jest.fn(),
  }
  const signer = new MonadAccountTxSigner({ privateKey: key, provider, httpClient: http })
  const input = { rawTx, txHash, recipient, chainId: 1n, funder: signer.address }
  return { signer, input, receipt, http, getBlock, getTransactionCount, getBalance }
}

describe('anchored funding observation on the actual signer', () => {
  it.each(['success', 'failure'] as const)('returns canonical included %s with pinned accounts', async status => {
    const f = await fixture()
    f.receipt.status = status
    expect(await f.signer.observeFunding(f.input)).toEqual({
      kind: 'included', execution: status, receiptBlock: { number: 10, hash: blockHash },
      accounts: { block: { number: 10, hash: blockHash }, senderNonce: 4n,
        recipientNonce: 0n, recipientBalance: 12n },
    })
    expect(f.getTransactionCount.mock.calls).toEqual([[f.signer.address, 10], [recipient, 10]])
    expect(f.getBalance).toHaveBeenCalledWith(recipient, 10)
    expect(f.getBlock.mock.calls).toEqual([[10], [10]])
    expect(f.http.submitRawTransaction).not.toHaveBeenCalled()
  })

  it('does not infer success from a positive balance without a receipt', async () => {
    const f = await fixture()
    f.http.getTransactionReceipt.mockResolvedValue(undefined)
    f.getTransactionCount.mockResolvedValue(3)
    expect(await f.signer.observeFunding(f.input)).toEqual({ kind: 'unresolved', reason: 'pending' })
    expect(f.getBlock.mock.calls).toEqual([['latest'], [10]])
  })

  it('reports coherent nonce supersession only after a repeated absent receipt', async () => {
    const f = await fixture()
    f.http.getTransactionReceipt.mockResolvedValue(undefined)
    expect(await f.signer.observeFunding(f.input)).toEqual({
      kind: 'superseded', accounts: { block: { number: 10, hash: blockHash },
        senderNonce: 4n, recipientNonce: 0n, recipientBalance: 12n },
    })
    expect(f.http.getTransactionReceipt.mock.calls).toEqual([[f.input.txHash], [f.input.txHash]])
  })

  it('does not supersede a receipt that appears during account reads', async () => {
    const f = await fixture()
    f.http.getTransactionReceipt.mockResolvedValueOnce(undefined)
    expect(await f.signer.observeFunding(f.input)).toEqual({ kind: 'unresolved', reason: 'inconsistent' })
  })

  it.each([
    { status: 'unknown' }, { txHash: otherHash }, { txHash: undefined as never }, { blockHash: '0x' },
    { blockNumber: -1 }, { blockNumber: Number.MAX_SAFE_INTEGER + 1 },
  ])('leaves invalid/unknown receipt evidence unresolved: %o', async patch => {
    const f = await fixture()
    Object.assign(f.receipt, patch)
    const res = await f.signer.observeFunding(f.input)
    expect(res).toEqual({
      kind: 'unresolved',
      reason: patch.status === 'unknown' ? 'unknown-execution' : 'inconsistent',
    })
    expect(f.getBalance).not.toHaveBeenCalled()
  })

  it('rejects included receipt when pinned sender nonce has not consumed the funding nonce', async () => {
    const f = await fixture()
    f.getTransactionCount.mockImplementation(async address => address === recipient ? 0 : 3)
    expect(await f.signer.observeFunding(f.input)).toEqual({ kind: 'unresolved', reason: 'inconsistent' })
  })

  it.each(['initial mismatch', 'replacement', 'missing'] as const)('rejects %s canonical block evidence', async mode => {
    const f = await fixture()
    if (mode === 'initial mismatch') f.getBlock.mockResolvedValue({ number: 10, hash: otherHash } as never)
    if (mode === 'replacement') f.getBlock.mockResolvedValueOnce({ number: 10, hash: blockHash } as never)
      .mockResolvedValueOnce({ number: 10, hash: otherHash } as never)
    if (mode === 'missing') f.getBlock.mockResolvedValue(null)
    expect(await f.signer.observeFunding(f.input)).toEqual({ kind: 'unresolved', reason: 'inconsistent' })
  })

  it.each(['receipt', 'block', 'accounts'] as const)('keeps %s RPC failures unavailable', async stage => {
    const f = await fixture()
    if (stage === 'receipt') f.http.getTransactionReceipt.mockRejectedValue(new Error('offline'))
    if (stage === 'block') f.getBlock.mockRejectedValue(new Error('offline'))
    if (stage === 'accounts') f.getBalance.mockRejectedValue(new Error('offline'))
    expect(await f.signer.observeFunding(f.input)).toEqual({ kind: 'unresolved', reason: 'unavailable' })
  })

  it.each([
    { recipient: new Wallet('0x' + '33'.repeat(32)).address },
    { funder: recipient }, { chainId: 2n }, { chainId: 0n }, { txHash: otherHash },
    { rawTx: '0x1234' },
  ])('rejects invalid caller bindings before RPC: %o', async patch => {
    const f = await fixture()
    await expect(f.signer.observeFunding({ ...f.input, ...patch })).rejects.toThrow()
    expect(f.http.getTransactionReceipt).not.toHaveBeenCalled()
    expect(f.getBlock).not.toHaveBeenCalled()
  })

  it.each([
    { value: 0n }, { data: '0x1234' }, { chainId: 0n }, { gasLimit: 0n },
    { accessList: [{ address: recipient, storageKeys: [] }] },
  ])('rejects invalid signed transfer %o', async patch => {
    const f = await fixture(patch)
    await expect(f.signer.observeFunding(f.input)).rejects.toThrow()
    expect(f.http.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('rejects a valid signature from a different signer', async () => {
    const f = await fixture()
    const tx = Transaction.from(f.input.rawTx)
    tx.signature = null
    f.input.rawTx = await new Wallet('0x' + '33'.repeat(32)).signTransaction(tx)
    f.input.txHash = Transaction.from(f.input.rawTx).hash!
    await expect(f.signer.observeFunding(f.input)).rejects.toThrow()
    expect(f.http.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('snapshots caller bindings before awaiting receipt lookup', async () => {
    const f = await fixture()
    let release!: (receipt: MonadTxReceipt) => void
    f.http.getTransactionReceipt.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const observed = f.signer.observeFunding(f.input)
    Object.assign(f.input, { recipient: f.signer.address, txHash: otherHash, funder: recipient, chainId: 2n, rawTx: '0x' })
    release(f.receipt)
    expect((await observed).kind).toBe('included')
    expect(f.getBalance).toHaveBeenCalledWith(recipient, 10)
  })
})
