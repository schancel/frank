import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SigningKey, Transaction, Wallet } from 'ethers'
import type { LevelDB } from 'level'
import * as durability from './level-durability'
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
