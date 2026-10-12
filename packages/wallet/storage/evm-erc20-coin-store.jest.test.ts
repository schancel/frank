import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import level from 'level'
import { Interface, Transaction, Wallet } from 'ethers'
import { getEvmDexDeployment } from '../chain/dex-deployments'
import {
  applyStoredNativeCoinObservation,
  EVM_COIN_NAMESPACE,
  fundedErc20Coins,
  LevelRecordStore,
  MemoryRecordStore,
  markStoredEvmCoinNoted,
  observeEvmCoin,
  receivedErc20Payments,
  refreshEvmErc20Position,
  refreshStoredEvmErc20Position,
  registerEvmErc20Payment,
  recordStoredEvmCoin,
  registerStoredEvmErc20Payment,
  registerStoredEvmNativePayment,
  spendableCoins,
  type EvmCoin,
  type EvmErc20Reader,
} from './evm-coin-store'

jest.mock('level', () => jest.fn(jest.requireActual('level')))

const sender = new Wallet('0x' + '01'.repeat(32))
const recipient = new Wallet('0x' + '02'.repeat(32))
const deployment = getEvmDexDeployment('monad-testnet')!
const usdc = deployment.tokens.find(token => token.symbol === 'USDC')!.address!
const chomp = deployment.tokens.find(token => token.symbol === 'CHOMP')!
  .address!
const abi = new Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])
const amount = (1n << 200n) + 123n
const hash = '0x' + 'ab'.repeat(32)
const digest = 'cd'.repeat(32)
const account = (): EvmCoin => ({
  address: recipient.address.toLowerCase(),
  privateKey: recipient.privateKey,
  origin: 'stealth',
  state: 'pending',
  amountWei: '0',
  claimedAmountWei: '0',
  transactions: [],
  ephemeralPubKey: sender.signingKey.compressedPublicKey.slice(2),
  discoveredAtMs: 1,
})
const signed = (
  token = usdc,
  value = amount,
  nonce = 0,
  destination = recipient.address,
  chainId = 10143n,
) =>
  sender.signTransaction({
    to: token,
    chainId,
    nonce,
    type: 2,
    value: 0n,
    data: abi.encodeFunctionData('transfer', [destination, value]),
    gasLimit: 100_000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  })
const payment = (
  rawTransaction: string,
  contractAddress = usdc,
  amountBaseUnits = amount,
) => ({
  chainIdentifier: 'monad-testnet',
  contractAddress,
  rawTransaction,
  amountBaseUnits,
  payloadDigest: digest,
  discoveredAtMs: 1,
})

function node(raw: string, balance = amount, token = usdc) {
  const tx = Transaction.from(raw)
  const event = abi.encodeEventLog(abi.getEvent('Transfer')!, [
    sender.address,
    recipient.address,
    amount,
  ])
  const receipt = {
    hash: tx.hash!,
    from: sender.address,
    to: token,
    status: 1,
    blockHash: hash,
    blockNumber: 10,
    logs: [{ address: token, ...event, index: 3 }],
  }
  const reader: EvmErc20Reader = {
    getBlock: jest.fn(async tag => ({
      hash,
      number: tag === 'latest' ? 10 : tag,
    })),
    call: jest.fn(async () => abi.encodeFunctionResult('balanceOf', [balance])),
    getTransactionReceipt: jest.fn(async requested =>
      requested === tx.hash ? receipt : null,
    ),
  }
  return { reader, receipt }
}
const options = (
  reader: EvmErc20Reader,
  contractAddress = usdc,
  atMs = 10,
) => ({ chainIdentifier: 'monad-testnet', contractAddress, reader, atMs })
const view = (coin: EvmCoin, nativeBalanceWei = 0n) =>
  receivedErc20Payments(coin, {
    nativeBalanceWei,
    requiredNativeFeeWei: 100_000n,
  })

const nativeSigned = (nonce = 0) =>
  sender.signTransaction({
    to: recipient.address,
    chainId: 10143n,
    type: 2,
    nonce,
    value: 1000n,
    data: '0x',
    gasLimit: 21000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  })
const nativePayment = (rawTransaction: string) => ({
  chainIdentifier: 'monad-testnet',
  ephemeralPubKey: account().ephemeralPubKey!,
  rawTransaction,
  amountWei: 1000n,
  payloadDigest: digest,
})

describe('received ERC20 positions under the account owner', () => {
  afterEach(() => jest.restoreAllMocks())

  it('verifies exact calldata/logs, retains zero-native funds and separates balance from received value', async () => {
    const raw = await signed()
    const registered = registerEvmErc20Payment(account(), payment(raw))
    expect(view(registered)[0]).toMatchObject({
      status: 'pending',
      claimedAmountBaseUnits: amount,
      receivedAmountBaseUnits: 0n,
    })
    const rpc = node(raw, 12n)
    const observed = await refreshEvmErc20Position(
      registered,
      options(rpc.reader),
    )
    expect(view(observed)[0]).toMatchObject({
      status: 'received',
      receivedAmountBaseUnits: amount,
      balanceBaseUnits: 12n,
      spendability: 'needs-native-gas',
    })
    expect(view(observed, 100_000n)[0]!.spendability).toBe('spendable')
    expect(view(observed, 99_999n)[0]!.spendability).toBe('needs-native-gas')
    expect(rpc.reader.call).toHaveBeenCalledWith({
      to: usdc.toLowerCase(),
      data: abi.encodeFunctionData('balanceOf', [recipient.address]),
      blockTag: 10,
    })
    const nativeEmpty = observeEvmCoin(observed, {
      balanceWei: 0n,
      transfer: 'none',
      atMs: 11,
    })
    expect(nativeEmpty.erc20Positions).toEqual(observed.erc20Positions)
    expect(spendableCoins([nativeEmpty])).toEqual([])
    expect(nativeEmpty.erc20Positions![0]).toMatchObject({
      observedBlockHash: hash,
      observedBlockNumber: 10,
    })
    expect(view(nativeEmpty)[0]!.receivedAmountBaseUnits).toBe(amount)
    expect(fundedErc20Coins([nativeEmpty], usdc)).toEqual([nativeEmpty])
  })

  it('deduplicates receipt membership and preserves two assets at the same address', async () => {
    const raw = await signed()
    let coin = registerEvmErc20Payment(account(), payment(raw))
    coin = registerEvmErc20Payment(coin, {
      ...payment(raw),
      payloadDigest: 'de'.repeat(32),
    })
    const rpc = node(raw)
    coin = await refreshEvmErc20Position(coin, options(rpc.reader))
    coin = await refreshEvmErc20Position(coin, options(rpc.reader))
    expect(coin.erc20Positions![0]!.receipts).toHaveLength(1)
    expect(view(coin)[0]).toMatchObject({
      receivedAmountBaseUnits: amount,
      payloadDigests: [digest, 'de'.repeat(32)],
    })
    const later = await signed(usdc, amount, 1)
    coin = registerEvmErc20Payment(coin, payment(later))
    const cumulative = node(later, amount * 2n)
    const firstReceipt = node(raw).receipt
    jest
      .spyOn(cumulative.reader, 'getTransactionReceipt')
      .mockImplementation(async txHash =>
        txHash === firstReceipt.hash ? firstReceipt : cumulative.receipt,
      )
    coin = await refreshEvmErc20Position(coin, options(cumulative.reader))
    expect(coin.erc20Positions![0]!.claims).toHaveLength(2)
    expect(coin.erc20Positions![0]!.receipts).toHaveLength(2)
    expect(
      view(coin).reduce((sum, item) => sum + item.receivedAmountBaseUnits, 0n),
    ).toBe(amount * 2n)
    const second = await signed(chomp, amount, 2)
    coin = registerEvmErc20Payment(coin, payment(second, chomp))
    coin = await refreshEvmErc20Position(
      coin,
      options(node(second, 42n, chomp).reader, chomp),
    )
    expect(coin.erc20Positions).toHaveLength(2)
    expect(coin.erc20Positions!.map(item => item.balanceBaseUnits)).toEqual([
      (amount * 2n).toString(),
      '42',
    ])
  })

  it('rejects wrong chain, token, destination and mismatched exact amount before mutation', async () => {
    const coin = account()
    for (const input of [
      { ...payment(await signed()), chainIdentifier: 'monad' },
      { ...payment(await signed()), contractAddress: sender.address },
      payment(await signed(usdc, amount, 0, sender.address)),
      payment(await signed(usdc, amount, 0, recipient.address, 1n)),
      payment(await signed(), usdc, amount - 1n),
      payment(await signed(), chomp),
    ])
      expect(() => registerEvmErc20Payment(coin, input)).toThrow()
    expect(coin.erc20Positions).toBeUndefined()
  })

  it('does not count unrelated logs, reverts, missing receipts or an unverified funded position', async () => {
    const raw = await signed()
    const registered = registerEvmErc20Payment(account(), payment(raw))
    const unrelated = node(raw)
    unrelated.receipt.logs[0]!.address = chomp
    const partial = await refreshEvmErc20Position(
      registered,
      options(unrelated.reader),
    )
    expect(view(partial)[0]).toMatchObject({
      status: 'partial',
      receivedAmountBaseUnits: 0n,
      spendability: 'unverified',
    })
    const reverted = node(raw, 0n)
    reverted.receipt.status = 0
    expect(
      view(
        await refreshEvmErc20Position(registered, options(reverted.reader)),
      )[0],
    ).toMatchObject({ status: 'failed', receivedAmountBaseUnits: 0n })
    const missing = node(raw)
    jest.spyOn(missing.reader, 'getTransactionReceipt').mockResolvedValue(null)
    expect(
      view(
        await refreshEvmErc20Position(registered, options(missing.reader)),
      )[0],
    ).toMatchObject({ status: 'pending', spendability: 'unverified' })
    const forged = node(raw)
    forged.receipt.blockHash = '0x' + 'ff'.repeat(32)
    await expect(
      refreshEvmErc20Position(registered, options(forged.reader)),
    ).rejects.toThrow(/inclusion/)
  })

  it('returns an orphaned successful receipt to pending after a canonical reorganization', async () => {
    const raw = await signed()
    const store = new MemoryRecordStore<EvmCoin>()
    await recordStoredEvmCoin(store, account())
    await registerStoredEvmErc20Payment(store, account().address, payment(raw))
    await refreshStoredEvmErc20Position(
      store,
      account().address,
      options(node(raw).reader),
    )
    expect(view(store.get(account().address)!)[0]).toMatchObject({
      status: 'received',
      receivedAmountBaseUnits: amount,
    })
    const replacement = node(raw, 0n)
    jest
      .spyOn(replacement.reader, 'getBlock')
      .mockImplementation(async tag => ({
        hash: '0x' + 'ef'.repeat(32),
        number: tag === 'latest' ? 11 : tag,
      }))
    jest
      .spyOn(replacement.reader, 'getTransactionReceipt')
      .mockResolvedValue(null)
    await refreshStoredEvmErc20Position(
      store,
      account().address,
      options(replacement.reader, usdc, 11),
    )
    const current = store.get(account().address)!
    expect(current.erc20Positions![0]!.receipts).toEqual([])
    expect(current.erc20Positions![0]!.claims[0]!.execution).toBeUndefined()
    expect(view(current)[0]).toMatchObject({
      status: 'pending',
      receivedAmountBaseUnits: 0n,
      balanceBaseUnits: 0n,
    })
    expect(fundedErc20Coins(store.all(), usdc)).toEqual([])
    // Re-inclusion restores one membership, without duplicate receipt value.
    await refreshStoredEvmErc20Position(
      store,
      account().address,
      options(node(raw).reader, usdc, 12),
    )
    expect(
      store.get(account().address)!.erc20Positions![0]!.receipts,
    ).toHaveLength(1)
    expect(
      view(store.get(account().address)!)[0]!.receivedAmountBaseUnits,
    ).toBe(amount)
  })

  it('preserves current native facts and rejects an out-of-order token refresh', async () => {
    const raw = await signed()
    const store = new MemoryRecordStore<EvmCoin>()
    const coin = registerEvmErc20Payment(account(), payment(raw))
    await store.put(coin.address, coin)
    let finish!: (value: string) => void
    let started!: () => void
    const starting = new Promise<void>(resolve => {
      started = resolve
    })
    const old = node(raw, 1n)
    jest.spyOn(old.reader, 'call').mockImplementation(async () => {
      started()
      return new Promise<string>(resolve => {
        finish = resolve
      })
    })
    const pending = refreshStoredEvmErc20Position(
      store,
      coin.address,
      options(old.reader),
    )
    await starting
    await applyStoredNativeCoinObservation(store, coin.address, {
      balanceWei: 123n,
      transfer: 'none',
      atMs: 20,
    })
    const newer = node(raw, 42n)
    jest.spyOn(newer.reader, 'getBlock').mockImplementation(async tag => ({
      hash,
      number: tag === 'latest' ? 11 : tag,
    }))
    expect(
      (
        await refreshStoredEvmErc20Position(
          store,
          coin.address,
          options(newer.reader, usdc, 30),
        )
      ).applied,
    ).toBe(true)
    finish(abi.encodeFunctionResult('balanceOf', [1n]))
    expect((await pending).applied).toBe(false)
    expect(store.get(coin.address)).toMatchObject({
      amountWei: '123',
      checkedAtMs: 20,
      erc20Positions: [{ balanceBaseUnits: '42', observedBlockNumber: 11 }],
    })
    await applyStoredNativeCoinObservation(store, coin.address, {
      balanceWei: 0n,
      transfer: 'none',
      atMs: 40,
    })
    expect(store.get(coin.address)!.erc20Positions![0]!.balanceBaseUnits).toBe(
      '42',
    )
  })

  it('merges a native update during token RPC without replacing it', async () => {
    const raw = await signed()
    const store = new MemoryRecordStore<EvmCoin>()
    const coin = registerEvmErc20Payment(account(), payment(raw))
    await store.put(coin.address, coin)
    const rpc = node(raw)
    jest.spyOn(rpc.reader, 'call').mockImplementation(async () => {
      await applyStoredNativeCoinObservation(store, coin.address, {
        balanceWei: 777n,
        transfer: 'none',
        atMs: 30,
      })
      await markStoredEvmCoinNoted(store, coin.address, 31)
      return abi.encodeFunctionResult('balanceOf', [amount])
    })
    expect(
      (
        await refreshStoredEvmErc20Position(
          store,
          coin.address,
          options(rpc.reader),
        )
      ).applied,
    ).toBe(true)
    expect(store.get(coin.address)!.amountWei).toBe('777')
    expect(store.get(coin.address)!.notedAtMs).toBe(31)
    expect(view(store.get(coin.address)!)[0]!.receivedAmountBaseUnits).toBe(
      amount,
    )
  })

  it('restores note-before-native-claim and claim-before-note without losing token or observed native facts', async () => {
    const raw = await nativeSigned()
    const tokenRaw = await signed()
    for (const claimFirst of [false, true]) {
      const store = new MemoryRecordStore<EvmCoin>()
      const note = account()
      const nativeClaim = {
        ...note,
        transactions: [raw.slice(2)],
        claimedAmountWei: '1000',
        payloadDigest: digest,
      }
      await recordStoredEvmCoin(store, claimFirst ? nativeClaim : note)
      await registerStoredEvmErc20Payment(
        store,
        note.address,
        payment(tokenRaw),
      )
      await applyStoredNativeCoinObservation(store, note.address, {
        balanceWei: 777n,
        transfer: 'included',
        transferValueWei: 1000n,
        atMs: 30,
      })
      const before = store.get(note.address)!
      await registerStoredEvmNativePayment(
        store,
        note.address,
        nativePayment(raw),
      )
      await recordStoredEvmCoin(store, note)
      await registerStoredEvmNativePayment(
        store,
        note.address,
        nativePayment(raw),
      )
      expect(store.get(note.address)).toMatchObject({
        amountWei: '777',
        checkedAtMs: 30,
        receivedAmountWei: '1000',
        claimedAmountWei: '1000',
        transactions: [raw.slice(2)],
        payloadDigest: digest,
        erc20Positions: before.erc20Positions,
      })
      for (const invalid of [
        { ...nativePayment(raw), chainIdentifier: 'monad' },
        { ...nativePayment(raw), amountWei: 999n },
        {
          ...nativePayment(raw),
          ephemeralPubKey: recipient.signingKey.compressedPublicKey.slice(2),
        },
        nativePayment(await nativeSigned(1)),
      ])
        await expect(
          registerStoredEvmNativePayment(store, note.address, invalid),
        ).rejects.toThrow()
      expect(store.get(note.address)!.transactions).toEqual([raw.slice(2)])
    }
  })

  it('repeated account discovery retains positions and refuses conflicting custody', async () => {
    const store = new MemoryRecordStore<EvmCoin>()
    const raw = await signed()
    const coin = registerEvmErc20Payment(account(), payment(raw))
    await recordStoredEvmCoin(store, coin)
    await recordStoredEvmCoin(store, account())
    expect(store.get(coin.address)!.erc20Positions).toEqual(coin.erc20Positions)
    await expect(
      recordStoredEvmCoin(store, { ...coin, privateKey: sender.privateKey }),
    ).rejects.toThrow(/key/)
    await expect(
      recordStoredEvmCoin(store, {
        ...coin,
        ephemeralPubKey: recipient.signingKey.compressedPublicKey.slice(2),
      }),
    ).rejects.toThrow(/derivation/)
    expect(store.get(coin.address)!.erc20Positions).toEqual(coin.erc20Positions)
  })

  it('reopens exact positions and compares durable bytes across two stale store wrappers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frank-erc20-coins-'))
    const raw = await signed()
    const actualLevel: typeof level = jest.requireActual('level')
    const database = actualLevel(join(root, EVM_COIN_NAMESPACE))
    // Node LevelDB permits one physical opener. Two wrappers share that real database here,
    // reproducing distinct browser caches without claiming a live cross-tab browser check.
    jest
      .mocked(level)
      .mockImplementationOnce(() => database)
      .mockImplementationOnce(() => database)
    let first: LevelRecordStore<EvmCoin> | undefined
    let second: LevelRecordStore<EvmCoin> | undefined
    try {
      first = await LevelRecordStore.open(root, EVM_COIN_NAMESPACE)
      const coin = registerEvmErc20Payment(account(), payment(raw))
      await first.put(coin.address, coin)
      second = await LevelRecordStore.open(root, EVM_COIN_NAMESPACE)
      const nativeRaw = await nativeSigned()
      await Promise.all([
        registerStoredEvmNativePayment(
          first,
          coin.address,
          nativePayment(nativeRaw),
        ),
        registerStoredEvmErc20Payment(second, coin.address, {
          ...payment(raw),
          payloadDigest: 'ef'.repeat(32),
        }),
      ])
      await applyStoredNativeCoinObservation(first, coin.address, {
        balanceWei: 999n,
        transfer: 'none',
        atMs: 20,
      })
      expect(second.get(coin.address)!.amountWei).toBe('0')
      await registerStoredEvmErc20Payment(second, coin.address, {
        ...payment(raw),
        payloadDigest: 'de'.repeat(32),
      })
      expect(second.get(coin.address)!.amountWei).toBe('999')
      await refreshStoredEvmErc20Position(
        second,
        coin.address,
        options(node(raw).reader),
      )
      const before = second.get(coin.address)!
      await second.close()
      first = undefined
      second = await LevelRecordStore.open(root, EVM_COIN_NAMESPACE)
      expect(second.get(coin.address)).toEqual(before)
      expect(before.transactions).toEqual([nativeRaw.slice(2)])
      expect(before.claimedAmountWei).toBe('1000')
      expect(before.erc20Positions![0]!.claims[0]!.payloadDigests).toContain(
        'ef'.repeat(32),
      )
      expect(view(second.get(coin.address)!)[0]!.receivedAmountBaseUnits).toBe(
        amount,
      )
    } finally {
      await second?.close()
      await first?.close()
      await database.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
