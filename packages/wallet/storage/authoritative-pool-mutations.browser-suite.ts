import { LevelSubAccountPoolStore } from './level-sub-account-pool-store'
import type { SubAccountRecord } from './sub-account-pool-storage'

let store: LevelSubAccountPoolStore | undefined
let captured: SubAccountRecord | undefined
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function open() {
  if (!store) {
    store = new LevelSubAccountPoolStore('/authoritative-hd-pool')
    await store.Open()
  }
  return store
}
export async function run(phase: string) {
  const owner = await open()
  if (phase === 'seed') {
    assert(owner.getAll().length === 0, 'new pool should be empty')
    await owner.mutate(() => ({
      records: [
        {
          expectedRevision: 0,
          record: {
            index: 0,
            address: 'offline-owned-target',
            status: 'available',
          },
        },
      ],
      result: undefined,
    }))
    return { revision: owner.getByIndex(0)!.revision }
  }
  if (phase === 'capture') {
    captured = owner.getByIndex(0)!
    return { revision: captured.revision }
  }
  if (phase === 'race-a' || phase === 'race-b') {
    assert(
      captured && captured.status !== 'funding',
      'capture nonfunding row before race'
    )
    try {
      await owner.mutate(() => ({
        records: [
          {
            expectedRevision: captured!.revision!,
            record: {
              index: captured!.index,
              address: captured!.address,
              lifecycle: captured!.lifecycle,
              status: phase === 'race-a' ? 'in-use' : 'retired',
            },
          },
        ],
        result: undefined,
      }))
      return { won: true, revision: owner.getByIndex(0)!.revision }
    } catch (error) {
      assert(
        String(error).includes('Stale pool revision'),
        'only a stale revision may lose'
      )
      return { won: false, revision: owner.getByIndex(0)!.revision }
    }
  }
  if (phase === 'reopen') {
    const row = owner.getByIndex(0)!
    assert(
      row.revision === 2 &&
        (row.status === 'in-use' || row.status === 'retired'),
      'winner must survive browser restart'
    )
    await owner.mutate((snapshot) => ({
      records: [
        {
          record: snapshot.records[0],
          expectedRevision: snapshot.records[0].revision!,
        },
      ],
      result: undefined,
    }))
    assert(
      owner.getByIndex(0)!.revision === 2,
      'identical replay must preserve revision'
    )
    return { revision: row.revision, status: row.status }
  }
  if (phase === 'close') {
    await owner.Close()
    store = undefined
    return { closed: true }
  }
  throw new Error('Unknown browser phase')
}
