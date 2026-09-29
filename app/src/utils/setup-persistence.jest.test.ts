import { persistSetupAndReload } from './setup-persistence'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('setup persistence boundary', () => {
  it('does not reload until both wallet and profile writes are durable', async () => {
    const walletWrite = deferred()
    const profileWrite = deferred()
    const location = { hash: '#/setup', reload: jest.fn() }
    const notifyError = jest.fn()

    const completion = persistSetupAndReload(
      { flushPersistence: () => walletWrite.promise },
      { flushPersistence: () => profileWrite.promise },
      location,
      notifyError,
    )

    walletWrite.resolve()
    await Promise.resolve()
    expect(location.reload).not.toHaveBeenCalled()

    profileWrite.resolve()
    await completion
    expect(location.hash).toBe('#/')
    expect(location.reload).toHaveBeenCalledTimes(1)
    expect(notifyError).not.toHaveBeenCalled()
  })

  it('does not reload when persistence fails', async () => {
    const location = { hash: '#/setup', reload: jest.fn() }
    const notifyError = jest.fn()
    const failure = new Error('disk full')

    await expect(
      persistSetupAndReload(
        { flushPersistence: () => Promise.resolve() },
        { flushPersistence: () => Promise.reject(failure) },
        location,
        notifyError,
      ),
    ).rejects.toThrow('disk full')

    expect(location).toEqual({ hash: '#/setup', reload: expect.any(Function) })
    expect(location.reload).not.toHaveBeenCalled()
    expect(notifyError).toHaveBeenCalledWith(failure)
  })

  it('normalizes non-Error persistence failures for the user', async () => {
    const location = { hash: '#/setup', reload: jest.fn() }
    const notifyError = jest.fn()

    await expect(
      persistSetupAndReload(
        { flushPersistence: () => Promise.reject('storage unavailable') },
        { flushPersistence: () => Promise.resolve() },
        location,
        notifyError,
      ),
    ).rejects.toThrow('storage unavailable')

    expect(notifyError).toHaveBeenCalledWith(expect.any(Error))
    expect(location.reload).not.toHaveBeenCalled()
  })
})
