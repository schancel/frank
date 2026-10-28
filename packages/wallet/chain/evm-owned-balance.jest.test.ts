import { fixture, mockBalances, START_BALANCE, offlineChain, roots } from './canonical-two-wallets.testutil'
import { evmWalletInternals } from '../evm-wallet'
beforeEach(() => mockBalances.clear())

jest.mock('../evm-provider', () => require('./canonical-two-wallets.testutil').offlineProviderModule())
jest.mock('../evm-http', () => require('./canonical-two-wallets.testutil').offlineHttpModule())
jest.mock('@frank/cashweb/relay/mailbox-client', () => require('./canonical-two-wallets.testutil').offlineMailboxModule())

it('never publishes or caches a partial owned balance after a required address read fails', async () => {
  const f = await fixture()
  try {
    const state = evmWalletInternals(f.alice)
    const key = state.material!.changeKeyring.deriveChangeAccount(0)
    const account = key.address.toLowerCase(), valueWei = 100000000000000000n
    mockBalances.set(account, valueWei)
    await state.coinList!.put({ account, nonce: 0, privateKey: key.privateKey, valueWei, origin: 'change', changeIndex: 0 })
    const good = await f.alice.getBalance()
    expect(good).toBe(START_BALANCE + valueWei)
    const complete = f.alice.getBalanceObservation!()
    const original = f.alice.provider.getBalance.bind(f.alice.provider)
    let blocked = true
    const read = jest.spyOn(f.alice.provider, 'getBalance').mockImplementation(async (address, tag) => {
      if (String(address).toLowerCase() === account && blocked) throw new Error('address RPC unavailable')
      return original(address, tag)
    })
    try {
      f.alice.invalidateBalanceCache!()
      await expect(f.alice.getBalance()).rejects.toThrow('address RPC unavailable')
      expect(f.alice.getBalanceObservation!()).toEqual(complete)
      blocked = false
      expect(await f.alice.getBalance()).toBe(good)
    } finally { read.mockRestore() }
  } finally { await f.close() }
}, 30000)

it('counts actual owned graph destinations before projection without making them selectable', async () => {
  const f = await fixture()
  try {
    await f.alice.getBalance()
    await f.alice.refreshTransactionSetInventory!()
    const preparer = f.alice.transactionSetPreparer!
    const set = await preparer.constructTransactionSet({ operationId: 'balance-own-change',
      amountWei: 100000000000000000n, kdf: () => f.bob.mainAccount.address })
    expect(set.otherTransactions.length).toBeGreaterThan(0)
    for (const tx of [...set.bundle, ...set.otherTransactions].sort((a, b) => a.nonce - b.nonce)) offlineChain.mine(tx.rawTransaction)
    // The stand-in mines into block1; advance this observation's canonical head to avoid
    // reusing ethers' immutable block1 balance cache after the fixture changes its state.
    jest.spyOn(f.alice.provider, 'getBlockNumber').mockResolvedValue(2)
    const block = await f.alice.provider.getBlock(1)
    jest.spyOn(f.alice.provider, 'getBlock').mockImplementation(async tag =>
      tag === 2 ? { ...block!, number: 2, hash: '0x' + '33'.repeat(32) } as typeof block : block)

    const owned = new Set([f.alice.mainAccount.address.toLowerCase(), f.alice.identity.address.raw.toLowerCase(),
      ...set.otherTransactions.map(tx => tx.destination.toLowerCase()),
      ...[...set.bundle, ...set.otherTransactions].map(tx => tx.sourceAccount.toLowerCase())])
    const actual = [...owned].reduce((sum, address) => sum + (mockBalances.get(address) ?? 0n), 0n)
    f.alice.invalidateBalanceCache!()
    expect(await f.alice.getBalance()).toBe(actual)
    const list = evmWalletInternals(f.alice).coinList!
    expect(set.otherTransactions.every(tx => list.latestOf(tx.destination) === undefined)).toBe(true)
    expect(preparer.getOperation(set.operationId)!.members.every(member => member.observation.state === 'unknown')).toBe(true)
    const row = preparer.getOperation(set.operationId)!
    for (const [index, member] of row.members.entries()) {
      const source = member.source.address
      await preparer.markExposed(set.operationId, index)
      await preparer.recordObservation(set.operationId, index, {
        state: 'included-success', transactionHash: member.signed!.transactionHash,
        blockHash: '0x' + '11'.repeat(32), blockNumber: 1, transactionIndex: index, feeWei: '0',
      }, {
        blockHash: '0x' + '33'.repeat(32), blockNumber: 2,
        nonce: [...offlineChain.mined.values()].filter(address => address === source).length,
        balanceWei: (mockBalances.get(source) ?? 0n).toString(),
      })
    }
    f.alice.invalidateBalanceCache!()
    expect(await f.alice.getBalance()).toBe(actual)
    expect(f.alice.getBalanceObservation!()!.parts!.pendingOwnOperations).toBe(0)

  } finally { await f.close() }
}, 30000)

it('observes 100 active accounts once each, bounded to six reads, with complete cache and address/head invalidation', async () => {
  const f = await fixture()
  try {
    await f.alice.getBalance()
    const state = evmWalletInternals(f.alice)
    for (let index = 0; index < 100; index++) {
      const key = state.material!.changeKeyring.deriveChangeAccount(index)
      mockBalances.set(key.address.toLowerCase(), 100n)
      await state.coinList!.put({ account: key.address, privateKey: key.privateKey, nonce: 0,
        valueWei: 100n, origin: 'change', changeIndex: index })
    }
    const oldBlock = await f.alice.provider.getBlock(1)
    let head = 1
    jest.spyOn(f.alice.provider, 'getBlockNumber').mockImplementation(async () => head)
    jest.spyOn(f.alice.provider, 'getBlock').mockImplementation(async tag =>
      ({ ...oldBlock!, number: Number(tag), hash: '0x' + Number(tag).toString(16).padStart(64, '0') }) as typeof oldBlock)
    let inflight = 0, maximum = 0
    const reads = jest.spyOn(f.alice.provider, 'getBalance').mockImplementation(async (address, block) => {
      expect(block).toBe(head)
      inflight++; maximum = Math.max(maximum, inflight)
      await Promise.resolve()
      inflight--
      return mockBalances.get(String(address).toLowerCase()) ?? 0n
    })
    const roots = new Set([f.alice.mainAccount.address.toLowerCase(), f.alice.identity.address.raw.toLowerCase()])
    expect(await f.alice.getBalance()).toBe(START_BALANCE + 10000n)
    expect(reads).toHaveBeenCalledTimes(100 + roots.size)
    expect(new Set(reads.mock.calls.map(([address]) => address)).size).toBe(reads.mock.calls.length)
    expect(maximum).toBeLessThanOrEqual(6)
    reads.mockClear()
    expect(await f.alice.getBalance()).toBe(START_BALANCE + 10000n)
    expect(reads).not.toHaveBeenCalled()
    const key = state.material!.changeKeyring.deriveChangeAccount(100)
    mockBalances.set(key.address.toLowerCase(), 7n)
    await state.coinList!.put({ account: key.address, privateKey: key.privateKey, nonce: 0,
      valueWei: 7n, origin: 'change', changeIndex: 100 })
    expect(await f.alice.getBalance()).toBe(START_BALANCE + 10007n)
    expect(reads).toHaveBeenCalledTimes(101 + roots.size)
    reads.mockClear(); head = 2
    expect(await f.alice.getBalance()).toBe(START_BALANCE + 10007n)
    expect(reads).toHaveBeenCalledTimes(101 + roots.size)
    expect(f.alice.getBalanceObservation!()!.parts!.observedBlock).toBe(2)
  } finally { await f.close() }
}, 30000)

it('rejects a changed canonical hash and never overwrites the last complete observation', async () => {
  const f = await fixture()
  try {
    const original = await f.alice.getBalance()
    const complete = f.alice.getBalanceObservation!()
    const block = await f.alice.provider.getBlock(1)
    let reads = 0
    jest.spyOn(f.alice.provider, 'getBlock').mockImplementation(async () => ({ ...block!,
      hash: '0x' + (++reads === 1 ? '11' : '22').repeat(32) }) as typeof block)
    f.alice.invalidateBalanceCache!()
    await expect(f.alice.getBalance()).rejects.toThrow('observation changed')
    expect(f.alice.getBalanceObservation!()).toEqual(complete)
    expect(f.alice.getBalanceObservation!()!.balance).toBe(original)
  } finally { await f.close() }
}, 30000)


it('includes a reserved pool account in owned total while strict payment capacity excludes it', async () => {
  const f = await fixture()
  try {
    const state = evmWalletInternals(f.alice)
    const pool = f.alice.pool
    pool.ensureSize(1)
    pool.setStatus(0, 'available')
    const key = state.material!.keyring.deriveSubAccount(0), account = key.address.toLowerCase()
    mockBalances.set(account, 300000000000000000n)
    await state.coinList!.put({ account, privateKey: key.privateKey, nonce: 0, valueWei: 300000000000000000n, origin: 'deterministic' })
    pool.restoreClaim('owned-but-held', [0])
    expect(await f.alice.getBalance()).toBe(START_BALANCE + 300000000000000000n)
    expect(await f.alice.getSpendableBalance!()).toBeLessThanOrEqual(START_BALANCE)
    expect(pool.isAccountClaimed(account)).toBe(true)
  } finally { await f.close() }
}, 30000)

it('rejects unknown change ownership rather than accepting a funded foreign target or a partial total', async () => {
  const f = await fixture()
  try {
    await f.alice.getBalance()
    const complete = f.alice.getBalanceObservation!()
    const state = evmWalletInternals(f.alice)
    const wrong = state.material!.changeKeyring.deriveChangeAccount(1)
    await state.coinList!.put({ account: wrong.address, privateKey: wrong.privateKey, nonce: 0,
      valueWei: 100n, origin: 'change', changeIndex: 0 })
    await expect(f.alice.getBalance()).rejects.toThrow('derivation mismatch')
    expect(f.alice.getBalanceObservation!()).toEqual(complete)
  } finally { await f.close() }
}, 30000)


it('reopens the same custody and recovers its known owned holdings without a new balance inventory', async () => {
  const f = await fixture()
  let reopened: typeof f.alice | undefined
  try {
    const state = evmWalletInternals(f.alice)
    const key = state.material!.changeKeyring.deriveChangeAccount(4)
    mockBalances.set(key.address.toLowerCase(), 12345n)
    await state.coinList!.put({ account: key.address, privateKey: key.privateKey,
      nonce: 0, valueWei: 12345n, origin: 'change', changeIndex: 4 })
    const expected = await f.alice.getBalance()
    await f.alice.close()
    reopened = await f.chain.createWallet(roots(0)) as typeof f.alice
    expect(await reopened.getBalance()).toBe(expected)
  } finally { await reopened?.close(); await f.close() }
}, 30000)

it('rejects an observation invalidated while a required read is still in flight', async () => {
  const f = await fixture()
  try {
    await f.alice.getBalance()
    const complete = f.alice.getBalanceObservation!()
    const original = f.alice.provider.getBalance.bind(f.alice.provider)
    let release!: () => void, entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    jest.spyOn(f.alice.provider, 'getBalance').mockImplementationOnce(async (address, head) => {
      entered(); await blocked
      return original(address, head)
    })
    f.alice.invalidateBalanceCache!()
    const pending = f.alice.getBalance()
    await started
    f.alice.invalidateBalanceCache!()
    release()
    await expect(pending).rejects.toThrow('observation changed')
    expect(f.alice.getBalanceObservation!()).toEqual(complete)
  } finally { await f.close() }
}, 30000)

it('uses the configured finalized spend-rule head for every amount instead of the newest block', async () => {
  const f = await fixture({ spendRuleHead: 'finalized' })
  try {
    await f.alice.getBalance()
    const block = await f.alice.provider.getBlock(1)
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 600)
    jest.spyOn(f.alice.provider, 'getBlockNumber').mockResolvedValue(45)
    jest.spyOn(f.alice.provider, 'getBlock').mockImplementation(async tag =>
      ({ ...block!, number: tag === 'finalized' ? 42 : Number(tag), hash: '0x' + '42'.repeat(32) }) as typeof block)
    const reads = jest.spyOn(f.alice.provider, 'getBalance').mockImplementation(async (address, head) => {
      expect(head).toBe(42)
      return mockBalances.get(String(address).toLowerCase()) ?? 0n
    })
    try {
      expect(await f.alice.getBalance()).toBe(START_BALANCE)
      expect(reads).toHaveBeenCalled()
      expect(f.alice.getBalanceObservation!()!.parts!.observedBlock).toBe(42)
    } finally { clock.mockRestore() }
  } finally { await f.close() }
}, 30000)
