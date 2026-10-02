import { withSetupCommitLock, resetSetupCommitLock } from './setup-lock'

describe('withSetupCommitLock (#308)', () => {
  beforeEach(() => {
    resetSetupCommitLock()
  })

  it('serializes concurrent tasks using in-process queue fallback', async () => {
    const order: number[] = []
    let finishFirst!: () => void
    const firstBlocked = new Promise<void>(resolve => {
      finishFirst = resolve
    })

    const task1 = withSetupCommitLock(async () => {
      order.push(1)
      await firstBlocked
      order.push(2)
    })

    const task2 = withSetupCommitLock(async () => {
      order.push(3)
    })

    // Allow task 1 to start
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(order).toEqual([1])

    finishFirst()
    await Promise.all([task1, task2])
    expect(order).toEqual([1, 2, 3])
  })

  it('releases lock and lets next task run when task throws', async () => {
    const task1 = withSetupCommitLock(async () => {
      throw new Error('boom')
    })
    await expect(task1).rejects.toThrow('boom')

    let ran = false
    await withSetupCommitLock(async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('uses navigator.locks when available', async () => {
    const mockRequest = jest.fn(
      async (_name: string, cb: () => Promise<unknown>) => cb(),
    )
    const originalNavigator = global.navigator
    try {
      Object.defineProperty(global, 'navigator', {
        value: { locks: { request: mockRequest } },
        configurable: true,
      })

      let executed = false
      await withSetupCommitLock(async () => {
        executed = true
      })

      expect(mockRequest).toHaveBeenCalledWith(
        'frank.setup.commit',
        expect.any(Function),
      )
      expect(executed).toBe(true)
    } finally {
      Object.defineProperty(global, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
    }
  })
})
