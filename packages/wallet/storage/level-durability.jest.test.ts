import type { LevelDB } from 'level'

import { durableBatch, durableDelete, durablePut } from './level-durability'

class MachineLossLevelAdapter {
  readonly stable = new Map<string, string>()
  readonly visible = new Map<string, string>()

  async put(
    key: string,
    value: string,
    options?: { sync?: boolean }
  ): Promise<void> {
    this.visible.set(key, value)
    if (options?.sync === true) this.stable.set(key, value)
  }

  async del(key: string, options?: { sync?: boolean }): Promise<void> {
    this.visible.delete(key)
    if (options?.sync === true) this.stable.delete(key)
  }

  async batch(
    operations: Array<
      { type: 'put'; key: string; value: string } | { type: 'del'; key: string }
    >,
    options?: { sync?: boolean }
  ): Promise<void> {
    for (const operation of operations) {
      if (operation.type === 'put')
        this.visible.set(operation.key, operation.value)
      else this.visible.delete(operation.key)
    }
    if (options?.sync === true) {
      this.stable.clear()
      for (const [key, value] of this.visible) this.stable.set(key, value)
    }
  }

  simulateMachineLoss(): void {
    this.visible.clear()
    for (const [key, value] of this.stable) this.visible.set(key, value)
  }
}

describe('wallet Level durability fence', () => {
  it('retains awaited authority puts, deletes, and batches across simulated machine loss', async () => {
    const adapter = new MachineLossLevelAdapter()
    const database = adapter as unknown as LevelDB

    await adapter.put('discarded', 'ambient-default')
    await durablePut(database, 'seed', 'exact-seed')
    await durableBatch(database, [
      { type: 'put', key: 'reservation', value: 'in-use' },
      { type: 'del', key: 'discarded' },
    ])
    await durableDelete(database, 'reservation')
    adapter.simulateMachineLoss()

    expect(adapter.visible).toEqual(
      new Map<string, string>([['seed', 'exact-seed']])
    )
  })
})
