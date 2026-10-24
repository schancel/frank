import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SigningKey, Transaction, Wallet } from 'ethers'
import type { LevelDB } from 'level'
import * as durability from './level-durability'
import { setEventLoopYieldForTesting } from '../chain/event-loop-yield'
import { EvmNativeOperationJournal, type EvmNativeOperation, type EvmNativePlan } from './evm-native-operation-journal'

const wallet = new Wallet('0x' + '41'.repeat(32))
const address = wallet.address.toLowerCase()
const binding = { chainIdentifier: 'monad-testnet', nativeChainId: '10143', publicTuple: 'signature-cache-test' }
function plan(nonce = 0): EvmNativePlan {
  return { kind: 'native', recipient: address, intendedValueWei: '1000', members: [{
    source: { kind: 'main', address }, dependencies: [],
    unsignedTransaction: Transaction.from({ type: 0, chainId: 10143, nonce, to: address, value: 1000n, gasLimit: 21000n, gasPrice: 1n }).unsignedSerialized,
  }] }
}

let root: string
let journal: EvmNativeOperationJournal
let database: LevelDB
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'frank-signature-cache-'))
  const open = durability.openDurableLevel
  jest.spyOn(durability, 'openDurableLevel').mockImplementation(async (...args) => {
    database = args[0]
    return open(...args)
  })
  journal = new EvmNativeOperationJournal({ location: root, binding })
  await journal.Open()
})
afterEach(async () => {
  setEventLoopYieldForTesting(null)
  jest.restoreAllMocks()
  await journal.Close()
  await rm(root, { recursive: true, force: true })
})
async function prepare(nonce = 0) {
  const input = plan(nonce)
  const signer = nonce === 0 ? wallet : new Wallet('0x' + '42'.repeat(32))
  input.members[0]!.source.address = signer.address.toLowerCase()
  return journal.prepare(input, [await signer.signTransaction(Transaction.from(input.members[0]!.unsignedTransaction))])
}

it('verifies new signed bytes once, reuses exact bytes across durable mutations, and rechecks after reopen', async () => {
  const recovered = jest.spyOn(SigningKey, 'recoverPublicKey')
  const row = await prepare()
  expect(recovered).toHaveBeenCalled()
  recovered.mockClear()
  await journal.markExposed(row.operationId, 0)
  await journal.recordObservation(await journal.beginCapture(row.operationId, 0), { state: 'pending' }, null)
  expect(recovered).not.toHaveBeenCalled()
  await prepare(1)
  expect(recovered).toHaveBeenCalled()
  await journal.Close()
  recovered.mockClear()
  await journal.Open()
  expect(recovered).toHaveBeenCalled()
})

it.each(['source', 'unsigned', 'raw', 'hash', 'binding', 'observation'] as const)(
  'rejects changed durable %s despite cached valid signature evidence', async field => {
    const row = await prepare()
    const original = JSON.stringify(row)
    const changed: EvmNativeOperation = JSON.parse(original)
    const member = changed.members[0]!
    if (field === 'source') member.source.address = new Wallet('0x' + '42'.repeat(32)).address.toLowerCase()
    if (field === 'unsigned') member.unsignedTransaction = plan(1).members[0]!.unsignedTransaction
    if (field === 'raw') member.signed!.rawTransaction = await new Wallet('0x' + '42'.repeat(32)).signTransaction(Transaction.from(member.unsignedTransaction))
    if (field === 'hash') member.signed!.transactionHash = '0x' + 'ab'.repeat(32)
    if (field === 'binding') changed.binding.publicTuple = 'other wallet'
    if (field === 'observation') member.observation = { state: 'invalid' } as unknown as typeof member.observation
    await database.put(`operation:${row.operationId}`, JSON.stringify(changed))
    await expect(journal.markExposed(row.operationId, 0)).rejects.toThrow()
    // A failed validation cannot poison the earlier valid entry or persist a mutation.
    expect(String(await database.get(`operation:${row.operationId}`))).toBe(JSON.stringify(changed))
    await database.put(`operation:${row.operationId}`, original)
    await expect(journal.markExposed(row.operationId, 0)).resolves.toMatchObject({ operationId: row.operationId })
  },
)

async function signedPlan(count: number, offset = 0) {
  const input = plan()
  input.members = []
  const raws: string[] = []
  for (let i = 0; i < count; i++) {
    const signer = new Wallet('0x' + (100 + offset + i).toString(16).padStart(64, '0'))
    const member = plan().members[0]!
    member.source.address = signer.address.toLowerCase()
    input.members.push(member)
    raws.push(await signer.signTransaction(Transaction.from(member.unsignedTransaction)))
  }
  input.intendedValueWei = String(1000 * count)
  return { input, raws }
}

it('warm multi-member mutation avoids per-four-member timers below the work budget', async () => {
  const { input, raws } = await signedPlan(16)
  const row = await journal.prepare(input, raws)
  jest.spyOn(performance, 'now').mockReturnValue(0)
  const host = jest.fn(async () => undefined)
  setEventLoopYieldForTesting(host)
  await journal.markExposed(row.operationId, 0)
  expect(host).not.toHaveBeenCalled()
  expect(journal.get(row.operationId).members.map(m => m.signed!.rawTransaction)).toEqual(raws)
})

it('cold maximum-size signature validation permits a host turn before publishing the row', async () => {
  const { input, raws } = await signedPlan(64)
  const original = SigningKey.recoverPublicKey
  let heartbeat: Promise<void> | undefined
  let observedUnpublished = false
  jest.spyOn(SigningKey, 'recoverPublicKey').mockImplementation((...args) => {
    heartbeat ??= new Promise<void>(resolve => setTimeout(() => {
      observedUnpublished = journal.list().length === 0
      resolve()
    }, 0))
    return original(...args)
  })
  const row = await journal.prepare(input, raws)
  expect(observedUnpublished).toBe(true)
  await heartbeat
  expect(row.members).toHaveLength(64)
  expect(row.members.map(m => m.signed!.rawTransaction)).toEqual(raws)
})

it('durable reload shares its work budget across cheap rows and yields to the host', async () => {
  const rows = []
  for (let i = 0; i < 8; i++) {
    const { input, raws } = await signedPlan(1, i)
    rows.push(await journal.prepare(input, raws))
  }
  let clock = 0
  jest.spyOn(performance, 'now').mockImplementation(() => (clock += 4))
  let hostTurns = 0
  setEventLoopYieldForTesting(() => new Promise(resolve => setTimeout(() => {
    hostTurns++
    resolve()
  }, 0)))
  await journal.markExposed(rows[0]!.operationId, 0)
  expect(hostTurns).toBeGreaterThan(0)
  expect(journal.list()).toHaveLength(8)
})
