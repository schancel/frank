import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getBytes, Interface, keccak256, Transaction, Wallet } from 'ethers'
import vectors from '../../domain-roots/vectors/domain-roots-v1.json'
import type { DomainPurpose, DomainRoot } from '../../domain-roots/src'
import type { MonadRootBundle } from './active-chain'
import { createEvmChain } from './evm-chain'
import type { EvmChainConfig } from './evm-chain-config'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import { InMemoryNativeTransactionAttemptStore } from './chain-wallet'
import { fixedStampDefault } from '../oracle/stamp-policy.testutil'
import { deriveEvmStealthAddress } from '../evm-stealth'
import { getEvmDexDeployment } from './dex-deployments'
import type { StealthPaymentReceiptClaim } from '../stealth-payment'

import {
  EVM_COIN_NAMESPACE,
  LevelRecordStore,
  type EvmCoin,
} from '../storage/evm-coin-store'
import {
  EVM_STEALTH_PREPARATION_NAMESPACE,
  type EvmStealthPreparation,
} from './evm-stealth-payments'
const MAIN = '0x4669eff913a3c595cea5fa92a600201e8e9e75d8'
const external = new Wallet('0x' + '31'.repeat(32))
const contact = new Wallet('0x' + '32'.repeat(32))
const abi = new Interface([
  'function transfer(address to,uint256 amount) returns(bool)',
  'function balanceOf(address owner) view returns(uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
])
const token = getEvmDexDeployment('monad-testnet')!
  .tokens.find(item => item.symbol === 'USDC')!
  .address!.toLowerCase()
function roots(): MonadRootBundle {
  const root = <P extends DomainPurpose>(purpose: P): DomainRoot<P> => ({
    registry: 'frank-domain-roots-v1',
    purpose,
    bytes: getBytes('0x' + vectors.vectors[0].outputs[purpose]),
  })
  return {
    evm: root('evm-wallet'),
    authentication: root('identity-authentication'),
    messaging: root('messaging-encryption'),
  }
}
function node(wallet: EvmChainWalletHandle) {
  const balances = new Map<string, bigint>([[MAIN, 0n]])
  const tokens = new Map<string, bigint>()
  const nonces = new Map<string, number>()
  const txs = new Map<string, ReturnType<typeof Transaction.from>>()
  const receipts = new Map<string, object>()
  let blockHash = '0x' + 'ab'.repeat(32)
  const provider = wallet.provider
  jest
    .spyOn(provider, 'getBlock')
    .mockImplementation(async () => ({ hash: blockHash, number: 1 } as never))
  jest.spyOn(provider, 'getBlockNumber').mockResolvedValue(1)
  jest
    .spyOn(provider, 'getBalance')
    .mockImplementation(
      async address => balances.get(String(address).toLowerCase()) ?? 0n,
    )
  jest
    .spyOn(provider, 'getTransactionCount')
    .mockImplementation(
      async address => nonces.get(String(address).toLowerCase()) ?? 0,
    )
  jest.spyOn(provider, 'getFeeData').mockResolvedValue({
    gasPrice: 1n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  } as never)
  jest.spyOn(provider, 'estimateGas').mockResolvedValue(21000n)
  jest
    .spyOn(provider, 'getTransaction')
    .mockImplementation(async hash => (txs.get(hash) as never) ?? null)
  jest
    .spyOn(provider, 'getTransactionReceipt')
    .mockImplementation(async hash => (receipts.get(hash) as never) ?? null)
  jest.spyOn(provider, 'call').mockImplementation(async request => {
    const decoded = abi.decodeFunctionData('balanceOf', String(request.data))
    return abi.encodeFunctionResult('balanceOf', [
      tokens.get(String(decoded[0]).toLowerCase()) ?? 0n,
    ])
  })
  function mine(raw: string, status = 1) {
    const tx = Transaction.from(raw),
      from = tx.from!.toLowerCase(),
      to = tx.to!.toLowerCase()
    if (receipts.has(tx.hash!)) return
    nonces.set(from, tx.nonce + 1)
    balances.set(
      from,
      (balances.get(from) ?? 0n) - tx.gasLimit - (status === 1 ? tx.value : 0n),
    )
    const logs: object[] = []
    if (status === 1 && tx.data === '0x')
      balances.set(to, (balances.get(to) ?? 0n) + tx.value)
    if (status === 1 && tx.data !== '0x') {
      const decoded = abi.decodeFunctionData('transfer', tx.data),
        destination = String(decoded[0]).toLowerCase(),
        amount = BigInt(decoded[1])
      tokens.set(from, (tokens.get(from) ?? 0n) - amount)
      tokens.set(destination, (tokens.get(destination) ?? 0n) + amount)
      logs.push({
        address: to,
        ...abi.encodeEventLog(abi.getEvent('Transfer')!, [
          from,
          destination,
          amount,
        ]),
        transactionHash: tx.hash,
        blockHash,
        blockNumber: 1,
        index: 0,
        removed: false,
      })
    }
    txs.set(
      tx.hash!,
      Object.assign(tx, { blockHash, blockNumber: 1, index: 0 }),
    )
    receipts.set(tx.hash!, {
      hash: tx.hash,
      from,
      to,
      status,
      blockHash,
      blockNumber: 1,
      index: 0,
      gasUsed: tx.gasLimit,
      gasPrice: 1n,
      logs,
    })
  }
  const broadcast = jest
    .spyOn(provider, 'broadcastTransaction')
    .mockImplementation(async raw => {
      mine(raw)
      return { hash: keccak256(raw) } as never
    })
  return {
    balances,
    tokens,
    nonces,
    txs,
    receipts,
    mine,
    broadcast,
    changeBlock: (hash: string) => {
      blockHash = hash
    },
  }
}
let importNonce = 0
let root: string,
  wallet: EvmChainWalletHandle,
  state: ReturnType<typeof node>,
  cfg: EvmChainConfig
beforeEach(async () => {
  importNonce = 0
  root = await mkdtemp(join(tmpdir(), 'frank-multisource-'))
  cfg = {
    networkId: 'monad-testnet',
    chainId: 10143,
    rpcChain: 'monad-testnet',
    relayBaseUrl: 'http://127.0.0.1:1',
    networkTag: 'MONT',
    stampBurnAddress: '0x000000000000000000000000000000000000dEaD',
    resolveDefaultStamp: fixedStampDefault(1n),
    defaultTopicVoteValueWei: 1n,
    subAccountPoolSize: 2,
    nativeInclusionWaitMs: 0,
    walletStorageLocation: join(root, 'wallet'),
    nativeAttemptStore: new InMemoryNativeTransactionAttemptStore(),
  }
  wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  state = node(wallet)
})
afterEach(async () => {
  await wallet.close()
  jest.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
const intent = (
  id: string,
  amountAtomic: bigint,
  asset: { kind: 'native' } | { kind: 'erc20'; contractAddress: string } = {
    kind: 'native',
  },
) => ({
  operationId: id,
  chainIdentifier: 'monad-testnet',
  asset,
  recipientSpendPublicKey: getBytes(contact.signingKey.compressedPublicKey),
  amountAtomic,
  maxNativeFeeAtomic: 42000n,
})
async function importOwned(
  amount: bigint,
  asset: { kind: 'native' } | { kind: 'erc20'; contractAddress: string } = {
    kind: 'native',
  },
  gasBalance = 0n,
) {
  const derived = deriveEvmStealthAddress({
    recipientSpendPubKey: wallet.identity!.compressedPubKey,
  })
  const address = derived.stealthAddress.toLowerCase()
  const raw = await external.signTransaction({
    type: 2,
    chainId: 10143n,
    nonce: importNonce++,
    to: asset.kind === 'native' ? address : asset.contractAddress,
    value: asset.kind === 'native' ? amount : 0n,
    data:
      asset.kind === 'native'
        ? '0x'
        : abi.encodeFunctionData('transfer', [address, amount]),
    gasLimit: 21000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  })
  state.mine(raw)
  if (asset.kind === 'erc20') state.balances.set(address, gasBalance)
  const claim: StealthPaymentReceiptClaim = {
    chainIdentifier: 'monad-testnet',
    asset,
    recipientDestination: getBytes(address),
    ephemeralPublicKey: derived.ephemeralPubKey,
    amountAtomic: amount,
    rawTransactions: [raw.slice(2)],
    payloadDigest: 'cd'.repeat(32),
  }
  await wallet.stealthReceipts!.record(claim)
  await wallet.stealthReceipts!.observe(claim)
  return { address, claim }
}
async function reopenWallet() {
  const old = state
  await wallet.close()
  jest.restoreAllMocks()
  wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  state = node(wallet)
  for (const field of [
    'balances',
    'tokens',
    'nonces',
    'txs',
    'receipts',
  ] as const)
    for (const [key, value] of old[field])
      (state[field] as Map<string, unknown>).set(key, value)
}
test('public native quote gathers fragmented owned accounts, freezes on reopen, signs one total budget, and retires partial members', async () => {
  const first = await importOwned(25000n),
    second = await importOwned(25000n)
  const payment = intent('fragmented-native', 6000n)
  const { maxNativeFeeAtomic: _, ...unsigned } = payment
  const quote = await wallet.stealthPayments!.quote!(unsigned)
  expect(quote.sources).toHaveLength(2)
  expect(quote.sourceAddress).toBeUndefined()
  expect(
    quote.sources!.reduce(
      (sum, source) => sum + source.recipientAmountAtomic,
      0n,
    ),
  ).toBe(6000n)
  expect(quote.estimatedNativeFeeAtomic).toBe(42000n)
  expect(wallet.getNativeOperations!()).toHaveLength(0)
  const balances = new Map(state.balances),
    receipts = new Map(state.receipts),
    txs = new Map(state.txs)
  await wallet.close()
  jest.restoreAllMocks()
  wallet = (await createEvmChain(cfg).createWallet(
    roots(),
  )) as EvmChainWalletHandle
  state = node(wallet)
  for (const [key, value] of balances) state.balances.set(key, value)
  for (const [key, value] of receipts) state.receipts.set(key, value)
  for (const [key, value] of txs) state.txs.set(key, value)
  expect(await wallet.stealthPayments!.quote!(unsigned)).toEqual(quote)
  await expect(
    wallet.stealthPayments!.prepare({ ...payment, maxNativeFeeAtomic: 21000n }),
  ).rejects.toThrow(/total fee/)
  // Fee approval itself is immutable: release this unused operation before making a fresh approval.
  expect(await wallet.stealthPayments!.release(payment.operationId)).toBe(true)
  const approved = { ...payment, operationId: 'fragmented-approved' }
  const prepared = await wallet.stealthPayments!.prepare(approved)
  expect(prepared.members).toHaveLength(2)
  expect(
    prepared.members.reduce(
      (sum, member) => sum + member.recipientAmountAtomic,
      0n,
    ),
  ).toBe(6000n)
  expect(
    new Set(
      prepared.members.map(member =>
        Transaction.from(member.rawTransaction).from!.toLowerCase(),
      ),
    ),
  ).toEqual(new Set([first.address, second.address]))
  expect(state.broadcast).not.toHaveBeenCalled()
  await wallet.stealthPayments!.expose({
    operationId: approved.operationId,
    payloadDigest: 'aa'.repeat(32),
  })
  state.mine(prepared.members[0]!.rawTransaction)
  expect(
    await wallet.stealthPayments!.reconcile(approved.operationId),
  ).toMatchObject({
    status: 'partial',
    intendedAmountAtomic: 6000n,
    verifiedReceivedAmountAtomic: prepared.members[0]!.recipientAmountAtomic,
  })
  const firstNonce =
    wallet.getNativeOperations!()[0]!.members[0]!.observation.state
  expect(firstNonce).toBe('included-success')
  await reopenWallet()
  expect(await wallet.stealthPayments!.get(approved.operationId)).toEqual(
    prepared,
  )
  await wallet.stealthPayments!.submit(approved.operationId)
  expect(
    await wallet.stealthPayments!.reconcile(approved.operationId),
  ).toMatchObject({
    status: 'succeeded',
    verifiedReceivedAmountAtomic: 6000n,
    nativeFeeAtomic: 42000n,
  })
  expect(state.broadcast.mock.calls.map(call => call[0])).toEqual([
    prepared.members[1]!.rawTransaction,
  ])
})
test('public ERC20 quote gathers funded fragments while skipping a gasless smaller account', async () => {
  const asset = { kind: 'erc20' as const, contractAddress: token }
  const gasless = await importOwned(1n, asset, 0n)
  const first = await importOwned(4n, asset, 50000n),
    second = await importOwned(4n, asset, 50000n)
  const payment = intent('fragmented-token', 7n, asset),
    { maxNativeFeeAtomic: _, ...unsigned } = payment
  const quote = await wallet.stealthPayments!.quote!(unsigned)
  expect(quote.sources).toHaveLength(2)
  expect(new Set(quote.sources!.map(source => source.sourceAddress))).toEqual(
    new Set([first.address, second.address]),
  )
  expect(
    quote.sources!.some(source => source.sourceAddress === gasless.address),
  ).toBe(false)
  expect(quote.assetBalanceAtomic).toBe(8n)
  payment.maxNativeFeeAtomic = quote.estimatedNativeFeeAtomic
  const prepared = await wallet.stealthPayments!.prepare(payment)
  expect(
    prepared.members.reduce(
      (sum, member) => sum + member.recipientAmountAtomic,
      0n,
    ),
  ).toBe(7n)
  expect(
    prepared.members.every(
      member => Transaction.from(member.rawTransaction).value === 0n,
    ),
  ).toBe(true)
  await wallet.stealthPayments!.expose({
    operationId: payment.operationId,
    payloadDigest: 'ab'.repeat(32),
  })
  state.mine(prepared.members[0]!.rawTransaction)
  expect(
    await wallet.stealthPayments!.reconcile(payment.operationId),
  ).toMatchObject({
    status: 'partial',
    verifiedReceivedAmountAtomic: prepared.members[0]!.recipientAmountAtomic,
  })
  await wallet.stealthPayments!.submit(payment.operationId)
  expect(
    await wallet.stealthPayments!.reconcile(payment.operationId),
  ).toMatchObject({ status: 'succeeded', verifiedReceivedAmountAtomic: 7n })
})
test('recipient records the complete native set, retries every original, and rolls canonical partial/full evidence back after a dropped receipt', async () => {
  const derived = deriveEvmStealthAddress({
    recipientSpendPubKey: wallet.identity!.compressedPubKey,
  })
  const senders = [external, contact]
  const raws = await Promise.all(
    senders.map(sender =>
      sender.signTransaction({
        type: 2,
        chainId: 10143n,
        nonce: 0,
        to: derived.stealthAddress,
        value: 1000n,
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }),
    ),
  )
  const claim: StealthPaymentReceiptClaim = {
    chainIdentifier: 'monad-testnet',
    asset: { kind: 'native' },
    recipientDestination: getBytes(derived.stealthAddress),
    ephemeralPublicKey: derived.ephemeralPubKey,
    amountAtomic: 2000n,
    rawTransactions: raws.map(raw => raw.slice(2)),
    payloadDigest: 'ab'.repeat(32),
  }
  await wallet.stealthReceipts!.record(claim)
  state.mine(raws[0]!)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'partial',
    verifiedReceivedAmountAtomic: 1000n,
  })
  state.broadcast.mockRejectedValueOnce(new Error('first retry uncertain'))
  await expect(wallet.stealthReceipts!.submit(claim)).rejects.toThrow(
    'uncertain',
  )
  expect(state.broadcast.mock.calls.map(call => call[0])).toEqual(raws)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'succeeded',
    verifiedReceivedAmountAtomic: 2000n,
  })
  state.receipts.delete(Transaction.from(raws[0]!).hash!)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'partial',
    verifiedReceivedAmountAtomic: 1000n,
  })
  state.changeBlock('0x' + 'ef'.repeat(32))
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'pending',
    verifiedReceivedAmountAtomic: 0n,
  })
  await expect(
    wallet.stealthReceipts!.record({ ...claim, amountAtomic: 1000n }),
  ).rejects.toThrow(/intended/)
  await expect(
    wallet.stealthReceipts!.record({
      ...claim,
      rawTransactions: [claim.rawTransactions[0]!, claim.rawTransactions[0]!],
    }),
  ).rejects.toThrow(/duplicate/)
})

test('frozen public allocation cannot redirect members and an explicit source remains bounded', async () => {
  const first = await importOwned(25000n),
    second = await importOwned(25000n)
  const payment = intent('frozen-allocation', 6000n),
    { maxNativeFeeAtomic: _, ...unsigned } = payment
  const quote = await wallet.stealthPayments!.quote!(unsigned)
  Object.assign(quote.sources![0]!, {
    sourceAddress: contact.address.toLowerCase(),
    recipientAmountAtomic: 6000n,
  })
  await expect(
    wallet.stealthPayments!.prepare({
      ...payment,
      sourceAddress: first.address,
    }),
  ).rejects.toThrow(/conflict/)
  const prepared = await wallet.stealthPayments!.prepare(payment)
  expect(
    new Set(
      prepared.members.map(member =>
        Transaction.from(member.rawTransaction).from!.toLowerCase(),
      ),
    ),
  ).toEqual(new Set([first.address, second.address]))
  expect(
    prepared.members.reduce(
      (sum, member) => sum + member.recipientAmountAtomic,
      0n,
    ),
  ).toBe(6000n)
})
test('a current fee increase fails the one total ceiling before claiming or signing any member', async () => {
  await importOwned(50000n)
  await importOwned(50000n)
  const payment = intent('fee-change', 40000n),
    { maxNativeFeeAtomic: _, ...unsigned } = payment
  const quote = await wallet.stealthPayments!.quote!(unsigned)
  expect(quote.sources).toHaveLength(2)
  jest.spyOn(wallet.provider, 'getFeeData').mockResolvedValue({
    gasPrice: 2n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 2n,
  } as never)
  await expect(wallet.stealthPayments!.prepare(payment)).rejects.toThrow(
    /total fee/,
  )
  expect(wallet.getNativeOperations!()).toHaveLength(0)
  expect(await wallet.stealthPayments!.quote!(unsigned)).toEqual(quote)
  expect(state.broadcast).not.toHaveBeenCalled()
})
test('honestly rejects more than sixteen required members and gasless-only token funds without funding them', async () => {
  for (let i = 0; i < 17; i++) await importOwned(22000n)
  const tooMany = intent('over-member-cap', 17000n),
    { maxNativeFeeAtomic: _, ...unsigned } = tooMany
  await expect(wallet.stealthPayments!.quote!(unsigned)).rejects.toThrow(
    /16-member/,
  )
  expect(wallet.getNativeOperations!()).toHaveLength(0)
  const gasless = await importOwned(
    10n,
    { kind: 'erc20', contractAddress: token },
    0n,
  )
  const tokenIntent = intent('gasless-only', 5n, {
    kind: 'erc20',
    contractAddress: token,
  })
  await expect(wallet.stealthPayments!.prepare(tokenIntent)).rejects.toThrow(
    /native gas/,
  )
  expect(state.balances.get(gasless.address)).toBe(0n)
  expect(state.broadcast).not.toHaveBeenCalled()
  expect(wallet.getNativeOperations!()).toHaveLength(0)
})
test.each([
  ['native', 'main'],
  ['native', 'owned'],
  ['erc20', 'main'],
  ['erc20', 'owned'],
] as const)(
  'reconsiders small sources at the member cap for %s using a larger %s source',
  async (kind, destination) => {
    const asset =
      kind === 'native'
        ? { kind: 'native' as const }
        : { kind: 'erc20' as const, contractAddress: token }
    for (let i = 0; i < 16; i++)
      await importOwned(
        kind === 'native' ? 22000n : 1n,
        asset,
        kind === 'native' ? 0n : 50000n,
      )
    let larger = MAIN
    if (destination === 'owned')
      larger = (
        await importOwned(kind === 'native' ? 100000n : 100n, asset, 50000n)
      ).address
    else {
      state.balances.set(MAIN, 100000n)
      if (kind === 'erc20') state.tokens.set(MAIN, 100n)
    }
    const payment = {
      ...intent(
        `cap-${kind}-${destination}`,
        kind === 'native' ? 17000n : 17n,
        asset,
      ),
      maxNativeFeeAtomic: 1000000n,
    }
    const { maxNativeFeeAtomic: _, ...unsigned } = payment
    const quote = await wallet.stealthPayments!.quote!(unsigned)
    expect(quote.sources!.length).toBeLessThanOrEqual(16)
    expect(quote.sources!.some(source => source.sourceAddress === larger)).toBe(
      true,
    )
    expect(
      quote.sources!.reduce(
        (sum, source) => sum + source.recipientAmountAtomic,
        0n,
      ),
    ).toBe(payment.amountAtomic)
    const prepared = await wallet.stealthPayments!.prepare(payment)
    expect(prepared.members).toHaveLength(quote.sources!.length)
    expect(
      prepared.members.reduce(
        (sum, member) => sum + member.recipientAmountAtomic,
        0n,
      ),
    ).toBe(payment.amountAtomic)
    expect(state.broadcast).not.toHaveBeenCalled()
  },
)
test('recipient sums independent ERC20 members across reopen and rolls back one missing receipt without losing native facts', async () => {
  const derived = deriveEvmStealthAddress({
    recipientSpendPubKey: wallet.identity!.compressedPubKey,
  })
  const values = [5n, 7n]
  const raws = await Promise.all(
    [external, contact].map((sender, index) =>
      sender.signTransaction({
        type: 2,
        chainId: 10143n,
        nonce: 0,
        to: token,
        value: 0n,
        data: abi.encodeFunctionData('transfer', [
          derived.stealthAddress,
          values[index]!,
        ]),
        gasLimit: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }),
    ),
  )
  const claim: StealthPaymentReceiptClaim = {
    chainIdentifier: 'monad-testnet',
    asset: { kind: 'erc20', contractAddress: token },
    recipientDestination: getBytes(derived.stealthAddress),
    ephemeralPublicKey: derived.ephemeralPubKey,
    amountAtomic: 12n,
    rawTransactions: raws.map(raw => raw.slice(2)),
    payloadDigest: 'ac'.repeat(32),
  }
  await wallet.stealthReceipts!.record(claim)
  state.mine(raws[0]!)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'partial',
    verifiedReceivedAmountAtomic: 5n,
    spendability: 'needs-native-gas',
  })
  await reopenWallet()
  await wallet.stealthReceipts!.submit(claim)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'succeeded',
    verifiedReceivedAmountAtomic: 12n,
    spendability: 'needs-native-gas',
  })
  state.receipts.delete(Transaction.from(raws[1]!).hash!)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
    status: 'partial',
    verifiedReceivedAmountAtomic: 5n,
  })
  expect(state.balances.get(derived.stealthAddress.toLowerCase()) ?? 0n).toBe(
    0n,
  )
})

test('concurrent complete preparations have one reservation winner while an unrelated owned source remains usable', async () => {
  const accounts = await Promise.all([
    importOwned(25000n),
    importOwned(25000n),
    importOwned(25000n),
  ])
  const a = intent('competing-a', 6000n),
    b = intent('competing-b', 6000n)
  const { maxNativeFeeAtomic: _, ...qa } = a,
    { maxNativeFeeAtomic: __, ...qb } = b
  const quotes = await Promise.all([
    wallet.stealthPayments!.quote!(qa),
    wallet.stealthPayments!.quote!(qb),
  ])
  expect(quotes[0]!.sources).toEqual(quotes[1]!.sources)
  const results = await Promise.allSettled([
    wallet.stealthPayments!.prepare(a),
    wallet.stealthPayments!.prepare(b),
  ])
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
    1,
  )
  expect(wallet.getNativeOperations!()).toHaveLength(1)
  const held = new Set(quotes[0]!.sources!.map(source => source.sourceAddress))
  const free = accounts.find(account => !held.has(account.address))!
  const independent = await wallet.stealthPayments!.prepare({
    ...intent('unrelated-during-pending', 1000n),
    sourceAddress: free.address,
  })
  expect(independent.members).toHaveLength(1)
  expect(
    Transaction.from(
      independent.members[0]!.rawTransaction,
    ).from!.toLowerCase(),
  ).toBe(free.address)
  expect(wallet.getNativeOperations!()).toHaveLength(2)
  expect(state.broadcast).not.toHaveBeenCalled()
})

test('an obsolete preparation format fails reopen without deleting its records or funded source profile', async () => {
  const source = await importOwned(25000n)
  const payment = intent('obsolete-format', 1000n),
    { maxNativeFeeAtomic: _, ...unsigned } = payment
  await wallet.stealthPayments!.quote!(unsigned)
  await wallet.close()
  jest.restoreAllMocks()
  const location = `${cfg.walletStorageLocation}-evm-${MAIN}`
  const store = await LevelRecordStore.open<EvmStealthPreparation>(
    location,
    EVM_STEALTH_PREPARATION_NAMESPACE,
  )
  const row = store.get(payment.operationId)!,
    { version: __, ...old } = row
  await store.compareAndPut(
    payment.operationId,
    row,
    old as unknown as EvmStealthPreparation,
  )
  await store.close()
  await expect(createEvmChain(cfg).createWallet(roots())).rejects.toThrow(
    /Unsupported EVM stealth preparation format/,
  )
  const retained = await LevelRecordStore.open<EvmStealthPreparation>(
    location,
    EVM_STEALTH_PREPARATION_NAMESPACE,
  )
  expect(retained.get(payment.operationId)).toEqual(old)
  await retained.close()
  const coins = await LevelRecordStore.open<EvmCoin>(
    location,
    EVM_COIN_NAMESPACE,
  )
  expect(coins.get(source.address)?.amountWei).toBe('25000')
  expect(coins.get(source.address)?.privateKey).toBeDefined()
  await coins.close()
})

test('an exposed singleton waiting for RPC does not serialize another fixed payment submission', async () => {
  const accounts = await Promise.all([importOwned(25000n), importOwned(25000n)])
  const first = await wallet.stealthPayments!.prepare({
    ...intent('singleton-wait', 1000n),
    sourceAddress: accounts[0]!.address,
  })
  const second = await wallet.stealthPayments!.prepare({
    ...intent('singleton-independent', 1000n),
    sourceAddress: accounts[1]!.address,
  })
  await wallet.stealthPayments!.expose({
    operationId: first.operationId,
    payloadDigest: 'ab'.repeat(32),
  })
  await wallet.stealthPayments!.expose({
    operationId: second.operationId,
    payloadDigest: 'cd'.repeat(32),
  })
  let release!: () => void, entered!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const original = jest
    .mocked(wallet.provider.getTransactionReceipt)
    .getMockImplementation()!
  let pause = true
  jest
    .spyOn(wallet.provider, 'getTransactionReceipt')
    .mockImplementation(async hash => {
      if (pause && hash === first.members[0]!.txHash) {
        pause = false
        entered()
        await blocked
      }
      return original(hash)
    })
  const slow = wallet.stealthPayments!.submit(first.operationId)
  try {
    await started
    const fast = await wallet.stealthPayments!.submit(second.operationId)
    expect(fast.status).toBe('pending')
    expect(
      (await wallet.stealthPayments!.reconcile(second.operationId)).status,
    ).toBe('succeeded')
    expect(state.broadcast).toHaveBeenCalledWith(
      second.members[0]!.rawTransaction,
    )
    expect(state.broadcast).not.toHaveBeenCalledWith(
      first.members[0]!.rawTransaction,
    )
  } finally {
    release()
    await slow
  }
  expect(state.broadcast).toHaveBeenCalledWith(first.members[0]!.rawTransaction)
})

test.each([1, 2])('late native receipt with %i members refreshes spendable inventory after empty observation', async count => {
  const derived = deriveEvmStealthAddress({
    recipientSpendPubKey: wallet.identity!.compressedPubKey,
  })
  const address = derived.stealthAddress.toLowerCase()
  const raws = await Promise.all([external, contact].slice(0, count).map(sender =>
    sender.signTransaction({ type: 2, chainId: 10143n, nonce: 0,
      to: address, value: 1000000n, gasLimit: 21000n,
      maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }),
  ))
  const claim: StealthPaymentReceiptClaim = {
    chainIdentifier: 'monad-testnet', asset: { kind: 'native' },
    recipientDestination: getBytes(address), ephemeralPublicKey: derived.ephemeralPubKey,
    amountAtomic: BigInt(count) * 1000000n,
    rawTransactions: raws.map(raw => raw.slice(2)), payloadDigest: 'ef'.repeat(32),
  }
  await wallet.stealthReceipts!.record(claim)
  expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({ status: 'pending' })
  const build = (operationId: string, amountWei: bigint) => wallet.constructTransactionSet!({
    operationId, amountAtomic: amountWei, kdf: () => getBytes(contact.address),
  })
  // This public construction caches the received account's empty chain observation.
  await expect(build('empty-receipt', 100000n)).rejects.toThrow('Insufficient available EVM coins')
  for (let index = 0; index < count; index++) {
    state.mine(raws[index]!)
    const total = BigInt(index + 1) * 1000000n
    expect(await wallet.stealthReceipts!.observe(claim)).toMatchObject({
      status: index + 1 === count ? 'succeeded' : 'partial',
      verifiedReceivedAmountAtomic: total,
    })
    // The second amount exceeds the first partial receipt. Ordinary construction must
    // reread the increased chain balance, without a full scan or reopening the wallet.
    const operationId = `included-receipt-${index}`
    const prepared = await build(operationId, total - 100000n)
    expect(prepared).toBeDefined()
    await wallet.transactionSetPreparer!.releaseUnexposed(operationId)
  }
})
