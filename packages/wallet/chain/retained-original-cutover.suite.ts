/** Registered once by outgoing-message-store.jest.test.ts (the configured CI suite).
 * Historical STORAGE writers, current typed construction/crypto/chain dependencies.
 * This is not a historical sender/codec or deployed-artifact compatibility assertion.
 */
import { fixture, mockBalances, mockFunded, mailboxes, offlineChain, type Fixture } from './canonical-two-wallets.testutil'
import { createHash } from 'node:crypto'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as ts from 'typescript'
import { getBytes, Transaction } from 'ethers'
import { EvmNativeOperationJournal, type EvmNativeOperation, type EvmNativePlan } from '../storage/evm-native-operation-journal'
import { LevelOutgoingMessageStore, type StoredMessage } from '../storage/outgoing-message-store'
import { evmWalletInternals } from '../evm-wallet'
import type { EvmChainWalletHandle } from '../evm-wallet-handle'
import type { MonadRootBundle } from '../evm-wallet-material'
import { installCanonicalDirectory } from './evm-chain'
import type { CanonicalDirectory } from './canonical-dm'
import { restoreCanonicalRequest } from '@frank/cashweb/relay/canonical-dm-transport'
import domainVectors from '../../domain-roots/vectors/domain-roots-v1.json'
import manifest from './fixtures/retained-1a/manifest.json'

jest.mock('../evm-provider', () => require('./canonical-two-wallets.testutil').offlineProviderModule())
jest.mock('../evm-http', () => require('./canonical-two-wallets.testutil').offlineHttpModule())
jest.mock('@frank/cashweb/relay/mailbox-client', () => require('./canonical-two-wallets.testutil').offlineMailboxModule())

type OldStore = Pick<LevelOutgoingMessageStore, 'all' | 'put' | 'close'>
type OldJournal = Pick<EvmNativeOperationJournal, 'binding' | 'Open' | 'Close' | 'prepare' | 'list' | 'authorizeTransactionSet' | 'markExposed' | 'beginCapture' | 'recordObservation' | 'markSyncApplied' | 'markTransactionSetInventoryApplied'>

/** Raw originals are verified BEFORE transpilation. Relative imports deliberately resolve
 * to CURRENT storage dependencies. No rewritten source, mock validator or production adapter.
 * Narrow export types describe only the old public methods actually called below; neither old
 * object is cast into the current wallet's port (it lacks self-copy/recovery methods).
 */
function historical<T>(name: keyof typeof manifest): T {
  const raw = readFileSync(join(__dirname, 'fixtures/retained-1a', `${name}.ts.txt`))
  expect(createHash('sha256').update(raw).digest('hex')).toBe(manifest[name].sha256)
  expect(raw.length).toBe(manifest[name].bytes)
  expect(manifest[name].source).toBe('1a2326ce0d02f351dbfdd3e67c0b5ea83692268a')
  const module: { exports: unknown } = { exports: {} }
  const source = ts.transpileModule(raw.toString('utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const dependency = (name: string): unknown => require(name.startsWith('.') ? resolve(__dirname, '../storage', name) : name)
  new Function('require', 'module', 'exports', source)(dependency, module, module.exports)
  return module.exports as T
}

const { LevelOutgoingMessageStore: HistoricalStore } = historical<{
  LevelOutgoingMessageStore: { open(location: string): Promise<OldStore> }
}>('outgoing-message-store')
const { EvmNativeOperationJournal: HistoricalJournal } = historical<{
  EvmNativeOperationJournal: new (options: ConstructorParameters<typeof EvmNativeOperationJournal>[0]) => OldJournal
}>('evm-native-operation-journal')

const MESSAGE = '198afe01-2367-4567-89ab-0123456789ab'
const OPERATION = `stamp-${MESSAGE.replace(/-/g, '')}`
function roots(): MonadRootBundle {
  const outputs = domainVectors.vectors[0].outputs
  const root = <P extends 'evm-wallet' | 'identity-authentication' | 'messaging-encryption'>(purpose: P) => ({
    registry: 'frank-domain-roots-v1' as const, purpose, bytes: getBytes(`0x${outputs[purpose]}`),
  })
  return { evm: root('evm-wallet'), authentication: root('identity-authentication'), messaging: root('messaging-encryption') }
}

/** Explicit old StoredMessage fields, not a spread of current-only policy facts. In particular
 * old code did not write `unstored`, `selfCopyOwed`, recovery ceilings or replacement graphs.
 * We cover the ordinary unsealed original, not those later operation families.
 */
function oldMessage(row: StoredMessage): StoredMessage {
  expect(row.version).toBe(2)
  expect(row.originalCombinedOperationId).toBeUndefined()
  expect(row.replacedOperationIds).toBeUndefined()
  expect(row.selfCopyOwed).toBeUndefined()
  expect(row.construction?.maxFeeWei).toBeUndefined()
  return {
    version: row.version, consumerId: row.consumerId, digest: row.digest,
    recipientSubject: row.recipientSubject, payments: row.payments,
    otherTransactions: row.otherTransactions, createdAt: row.createdAt,
    ...(row.request ? { request: row.request } : {}),
    ...(row.transactionSetOperationId ? { transactionSetOperationId: row.transactionSetOperationId } : {}),
    ...(row.transactionSetStageId ? { transactionSetStageId: row.transactionSetStageId } : {}),
    ...(row.paymentOperationId ? { paymentOperationId: row.paymentOperationId } : {}),
    ...(row.construction ? { construction: row.construction } : {}),
    ...(row.outcome ? { outcome: row.outcome } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.accounted ? { accounted: row.accounted } : {}),
    ...(row.exposurePending ? { exposurePending: row.exposurePending } : {}),
    ...(row.unexposed ? { unexposed: row.unexposed } : {}),
  }
}

function originalGraph(row: EvmNativeOperation) {
  return {
    operationId: row.operationId, preparationId: row.preparationId,
    recipient: row.recipient, intendedValueWei: row.intendedValueWei,
    members: row.members.map(member => ({
      source: member.source, unsignedTransaction: member.unsignedTransaction,
      signed: member.signed, dependencies: member.dependencies,
      transactionSet: member.transactionSet && (({ inventoryApplied: _checkpoint, ...intent }) => intent)(member.transactionSet),
    })),
  }
}

const cuts = ['durable-held', 'handoff-no-ack', 'stored-no-ack', 'ack-pre-settlement'] as const
describe('historical1a storage writers -> current retained original graph (synthetic only)', () => {
  jest.setTimeout(60_000)
  let f: Fixture
  let alice: EvmChainWalletHandle
  let directory: CanonicalDirectory
  let mode: 'missing-recipient' | 'normal'
  let requests: { body: string; contentType: string }[]
  let prepares: { plan: EvmNativePlan; signed: readonly string[] | undefined; operation: EvmNativeOperation }[]
  let native: EvmNativeOperationJournal
  let location: string
  let store: LevelOutgoingMessageStore
  let openSpy: jest.SpyInstance
  let prepareSpy: jest.SpyInstance

  beforeEach(() => {
    offlineChain.reset(); mockBalances.clear(); mockFunded.length = 0; mailboxes.clear()
    offlineChain.relayBroadcasts = false
    requests = []; prepares = []; mode = 'normal'
    const open = LevelOutgoingMessageStore.open
    openSpy = jest.spyOn(LevelOutgoingMessageStore, 'open').mockImplementation(async path => {
      const opened = await open(path)
      // Alice's path is selected after fixture creation; Bob's independent store stays open.
      return opened
    })
    const openJournal = EvmNativeOperationJournal.prototype.Open
    jest.spyOn(EvmNativeOperationJournal.prototype, 'Open').mockImplementation(async function (this: EvmNativeOperationJournal) {
      await openJournal.call(this)
      native = this
    })
    const prepare = EvmNativeOperationJournal.prototype.prepare
    prepareSpy = jest.spyOn(EvmNativeOperationJournal.prototype, 'prepare').mockImplementation(async function (this: EvmNativeOperationJournal, plan, signed) {
      native = this
      const operation = await prepare.call(this, plan, signed)
      prepares.push({ plan, signed, operation })
      return operation
    })
  })
  afterEach(async () => {
    if (alice) await alice.close().catch(() => undefined)
    if (f) await f.close().catch(() => undefined)
    jest.restoreAllMocks()
  })

  async function currentStore() {
    const suffix = `-evm-${(await alice.getReceiveAddress()).raw.toLowerCase()}`
    const index = openSpy.mock.calls.map(call => String(call[0]).endsWith(suffix)).lastIndexOf(true)
    expect(index).toBeGreaterThanOrEqual(0)
    location = String(openSpy.mock.calls[index][0])
    store = await openSpy.mock.results[index].value
    return store
  }
  /** Only the original carried payment accounts/nonces, not provisional change/funding
   * slots whose settlement legitimately advances during a reconcile tick. Check the journal's
   * authoritative selection gate as well as the matching coin's durable workflow holder.
   */
  function reservations() {
    const coins = evmWalletInternals(alice).coinList!.all()
    return native.list()[0].members
      .filter(member => member.transactionSet?.role === 'payment')
      .map(member => {
        const account = member.source.address
        const nonce = Transaction.from(member.unsignedTransaction).nonce
        const coin = coins.find(candidate => candidate.account === account && candidate.nonce === nonce)
        return { account, nonce, selectable: native.canSelect(account, nonce), holder: coin?.holder ?? null }
      })
      .sort((a, b) => a.account.localeCompare(b.account) || a.nonce - b.nonce)
  }

  async function reopen() {
    alice = await f.chain.createWallet(roots()) as EvmChainWalletHandle
    installCanonicalDirectory(alice, directory)
    await currentStore()
  }
  async function produce(cut: typeof cuts[number]) {
    f = await fixture(); alice = f.alice
    f.setPhase('delivered')
    let durableCallbacks = 0
    let sendError: unknown
    const base = await f.directoryFor('alice', alice, f.bob)
    directory = {
      ...base,
      fetch: async (url, init) => {
        const request = { body: Buffer.from(init.body!).toString('hex'), contentType: init.headers['Content-Type'] }
        requests.push(request)
        if (mode === 'normal') {
          if (cut === 'handoff-no-ack') throw new Error('synthetic handoff acknowledgement lost')
          // Acknowledged delivery is still before settlement: make the chain unavailable
          // at this exact boundary so the current wallet cannot mine its post-ACK replay.
          if (cut === 'ack-pre-settlement') offlineChain.nodeDown = true
          const response = await base.fetch!(url, init)
          if (cut === 'stored-no-ack') throw new Error('synthetic stored acknowledgement lost')
          return response
        }
        // Exact current relay's empty-directory semantic answer (source handle_put65–86).
        const answer = new TextEncoder().encode(JSON.stringify({ version: 1, phase: 'dead',
          identity: restoreCanonicalRequest({ body: Buffer.from(request.body, 'hex'), contentType: request.contentType }).identity,
          reason: 'undeliverable' }))
        let read = false
        return { status: 200, url, headers: { get: (name: string) => name.toLowerCase() === 'content-type' ? 'application/json' : null },
          body: { getReader: () => ({ read: async () => read ? { done: true } : ((read = true), { done: false, value: answer }),
            cancel: async () => undefined, releaseLock: () => undefined }) } }
      },
    }
    installCanonicalDirectory(alice, directory)
    await f.chain.directMessages.send({ wallet: alice, recipient: f.bob.identity.address,
      messageId: MESSAGE, sealedSender: false, items: [{ type: 'text', text: 'synthetic retained original' }],
      onEnvelopeDurable: async () => {
        durableCallbacks++
        if (cut === 'durable-held') throw new Error('synthetic host barrier held')
      },
    }).catch((error: unknown) => { sendError = error })
    await currentStore()
    const row = oldMessage(store.all()[0])
    expect(row.consumerId).toBe(`frank-dm:${MESSAGE.replace(/-/g, '')}`)
    expect(row.payments.length).toBeGreaterThan(0)
    expect(prepares).toHaveLength(1)
    const graph = native.list()
    expect(graph).toHaveLength(1)
    const claims = reservations()
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.every(claim => !claim.selectable && claim.holder === OPERATION)).toBe(true)
    // Witness the named cut independently of the later reconciliation. An arbitrary earlier
    // failure must never collapse handoff/stored cases into the durable-held case.
    expect(durableCallbacks).toBeGreaterThan(0)
    const carried = graph[0].members.filter(member => member.transactionSet?.role === 'payment')
    expect(carried.length).toBeGreaterThan(0)
    expect(carried.every(member => member.exposed)).toBe(cut !== 'durable-held')
    expect(carried.every(member => !offlineChain.mined.has(member.signed!.transactionHash))).toBe(true)
    if (cut === 'durable-held') {
      expect(sendError).toEqual(new Error('synthetic host barrier held'))
      expect(requests).toHaveLength(0)
      expect(f.requests).toHaveLength(0)
      expect(row.exposurePending).toBe(true)
    } else {
      expect(requests.length).toBeGreaterThan(0)
      expect(row.exposurePending).toBeUndefined()
      if (cut === 'handoff-no-ack') expect(f.requests).toHaveLength(0)
      else {
        expect(f.requests.length).toBeGreaterThan(0)
        expect(carried.every(member => offlineChain.relayStored.has(member.signed!.transactionHash))).toBe(true)
      }
    }
    if (cut === 'ack-pre-settlement') {
      expect(sendError).toBeUndefined()
      expect(row.outcome).toBe('delivered')
      expect(row.request).toBeUndefined()
    } else {
      expect(row.outcome).toBeUndefined()
      expect(row.request).toBeDefined()
      expect(requests.every(request => request.body === row.request!.body && request.contentType === row.request!.contentType)).toBe(true)
    }
    const original = originalGraph(graph[0])
    const binding = native.binding
    await alice.close()

    // Only this fixture's fresh synthetic namespaces are replaced. Preserve its real coin,
    // custody, directory and other stores. Real historical validators write the original graph.
    rmSync(join(location, 'outgoing-messages-v1'), { recursive: true, force: true })
    rmSync(join(location, 'evm-native-operations-v1'), { recursive: true, force: true })
    const historicalStore = await HistoricalStore.open(location)
    try { await historicalStore.put(row) } finally { await historicalStore.close() }
    const historicalJournal = new HistoricalJournal({ location, binding })
    await historicalJournal.Open()
    try {
      const prepared = await historicalJournal.prepare(prepares[0].plan, prepares[0].signed)
      expect(prepared.operationId).toBe(graph[0].operationId)
      if (graph[0].submissionAuthorized) await historicalJournal.authorizeTransactionSet(prepared.operationId)
      for (const [index, member] of graph[0].members.entries()) {
        if (member.exposed) await historicalJournal.markExposed(prepared.operationId, index)
        if (member.observation.state !== 'unknown' || member.account !== null)
          expect(await historicalJournal.recordObservation(historicalJournal.beginCapture(prepared.operationId, index), member.observation, member.account)).toBe(true)
        if (member.syncApplied) await historicalJournal.markSyncApplied(prepared.operationId, index)
        if (member.transactionSet?.inventoryApplied) await historicalJournal.markTransactionSetInventoryApplied(prepared.operationId, index)
      }
      expect(originalGraph(historicalJournal.list()[0])).toEqual(original)
    } finally { await historicalJournal.Close() }
    return { row, original, claims }
  }

  it.each(cuts)('reopens complete old-valid original at %s without replacement or released reservations', async cut => {
    const { row, original, claims } = await produce(cut)
    const signedCount = prepareSpy.mock.calls.length
    for (let pass = 0; pass < 2; pass++) {
      await reopen()
      expect(store.all()).toEqual([row])
      const operation = await alice.transactionSetPreparer!.readOperation(OPERATION)
      expect(operation).toBeDefined()
      expect(originalGraph(operation!)).toEqual(original)
      expect(reservations()).toEqual(claims)
      expect(prepareSpy.mock.calls.length).toBe(signedCount)
      await alice.close()
    }
    await reopen()
    mode = 'missing-recipient'
    const before = requests.length
    const statuses = await f.chain.directMessages.reconcileAttempts({ wallet: alice, payloadDigests: [row.digest], messageIds: [MESSAGE],
      onEnvelopeDurable: async () => undefined })
    expect(statuses[row.digest]).toBe(row.outcome === 'delivered' ? 'delivered' : 'live')
    expect(prepareSpy.mock.calls.length).toBe(signedCount)
    expect(reservations()).toEqual(claims)
    const retained = store.all()[0]
    expect(retained.digest).toBe(row.digest)
    expect(retained.payments.map(payment => payment.rawTx)).toEqual(row.payments.map(payment => payment.rawTx))
    expect(originalGraph((await alice.transactionSetPreparer!.readOperation(OPERATION))!)).toEqual(original)
    if (row.request) {
      expect(requests.length).toBeGreaterThan(before)
      expect(requests.slice(before).every(request => request.body === row.request!.body && request.contentType === row.request!.contentType)).toBe(true)
      expect(retained.request).toEqual(row.request)
    } else {
      expect(row.outcome).toBe('delivered')
    }
  })

  it('fails visibly on a missing durable financial graph instead of replacing its original', async () => {
    const { row } = await produce('handoff-no-ack')
    const signedCount = prepareSpy.mock.calls.length
    rmSync(join(location, 'evm-native-operations-v1'), { recursive: true, force: true })
    await expect(reopen()).rejects.toThrow()
    expect(prepareSpy.mock.calls.length).toBe(signedCount)
    const retained = await LevelOutgoingMessageStore.open(location)
    try { expect(retained.all()).toEqual([row]) } finally { await retained.close() }
  })
})
